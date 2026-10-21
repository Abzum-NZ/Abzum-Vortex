"use client";

import { createContext, useContext, useEffect } from "react";
import {
  canonicalJson,
  compiledItemSettings,
  isRecord,
  readRecordsTableContract,
  plainSourceSettingValue,
  typedSourceSettings,
  type GridLayout,
  type GridLayoutCommitResult,
  type RecordsTableSortKey,
  type SourceBlockPropertyValueContract,
  type PlatformBlockRelease,
} from "@vortex/platform/schema";
import type { DisplayEventHandlers } from "../display/projected-data";

type Group = Extract<SourceBlockPropertyValueContract, { kind: "group" }>;

/** A committed canvas arrangement in the definition's ordinary field-reference spelling. */
export type StudioCanvasGridArrangement = Readonly<{
  placementAlias: string;
  key: string;
  /** Column order, widths, visibility, pinning, density, sort, filters and search. */
  state: Group;
}>;

/** The sort, typed filters (address spelling) and search a person chose on the canvas grid. */
export type StudioCanvasGridQuery = Readonly<{
  sort: readonly RecordsTableSortKey[];
  filters: readonly Readonly<{ fieldId: string; filter: string }>[];
  search: string | null;
}>;

/**
 * What the preview reads for one grid: its query state and the layout whose shown columns the
 * read projects. It changes only with a query change or a newly shown, unloaded column, so a
 * layout-only gesture reads nothing.
 */
export type StudioCanvasGridRead = StudioCanvasGridQuery &
  Readonly<{
    layout?: GridLayout;
    /** Counts the explicit re-reads (a retry, a newly shown column) so a repeated state still reads. */
    reread: number;
  }>;

/** Everything the canvas holds of one grid between its events and the inspector's capture. */
export type StudioCanvasGridState = Readonly<{
  placementAlias: string;
  /** The query, columns and density the held state belongs to. */
  key: string;
  /** The key the grid has now; a held state of another key is stale and is neither read nor kept. */
  currentKey: string;
  layout: Readonly<{ layout: GridLayout; state: Group }> | undefined;
  query: Readonly<{ query: StudioCanvasGridQuery; state: Group }>;
  read: StudioCanvasGridRead | undefined;
}>;

/** A query or authored layout change invalidates an earlier interactive arrangement. */
export const studioCanvasGridKey = (
  query: unknown,
  settings: Readonly<Record<string, unknown>>,
): string => {
  const features = settings.features;
  return canonicalJson([
    query ?? null,
    ...["columns", "density", "query_parameters", "sortable_fields", "default_sort"].map(
      (key) => settings[key] ?? null,
    ),
    isRecord(features)
      ? [
          features.search,
          features.column_filters,
          isRecord(features.saved_views) ? features.saved_views.enabled : null,
        ]
      : null,
  ]);
};

type StudioCanvasGridEvent =
  | Readonly<{ kind: "sync" }>
  | Readonly<{ kind: "layout"; layout: GridLayout }>
  | Readonly<{ kind: "sort"; keys: readonly RecordsTableSortKey[] }>
  | Readonly<{ kind: "filter"; fieldId: string; filter: string }>
  | Readonly<{ kind: "search"; text: string }>
  /** A column was shown that the last read did not carry, or the person retried. */
  | Readonly<{ kind: "refresh" }>;

/** One event of a canvas grid, on the one channel the grid already reports through. */
export type StudioCanvasGridChange = Readonly<{
  placementAlias: string;
  key: string;
  /** The compiled field identity (lower case) to the field reference the definition stores. */
  fields: ReadonlyMap<string, string>;
}> &
  StudioCanvasGridEvent;

const field = (
  fields: ReadonlyMap<string, string>,
  fieldId: string,
): SourceBlockPropertyValueContract => {
  const reference = fields.get(fieldId.toLowerCase());

  return { kind: "field_reference", field: reference! };
};

const layoutGroup = (layout: GridLayout, fields: ReadonlyMap<string, string>): Group => ({
  kind: "group",
  properties: {
    columns: {
      kind: "list",
      items: layout.columns.map((column): Group => ({
        kind: "group",
        properties: {
          field: field(fields, column.fieldId),
          visible: { kind: "boolean", value: column.visible },
          pin: { kind: "choice", value: column.pin },
          ...(column.width === undefined
            ? {}
            : { width: { kind: "number" as const, value: column.width } }),
        },
      })),
    },
    ...(layout.density === undefined
      ? {}
      : { density: { kind: "choice" as const, value: layout.density } }),
  },
});

const queryGroup = (query: StudioCanvasGridQuery, fields: ReadonlyMap<string, string>): Group => ({
  kind: "group",
  properties: {
    sort: {
      kind: "list",
      items: query.sort.map((key): Group => ({
        kind: "group",
        properties: {
          field: field(fields, key.fieldId),
          direction: { kind: "choice", value: key.direction },
        },
      })),
    },
    filters: {
      kind: "list",
      items: query.filters.map((entry): Group => ({
        kind: "group",
        properties: {
          field: field(fields, entry.fieldId),
          filter: { kind: "text", value: entry.filter },
        },
      })),
    },
    ...(query.search === null ? {} : { search: { kind: "text" as const, value: query.search } }),
  },
});

const noQuery: StudioCanvasGridState["query"] = {
  query: { sort: [], filters: [], search: null },
  state: queryGroup({ sort: [], filters: [], search: null }, new Map()),
};

/**
 * Applies one grid event to the held state. A change under another key starts afresh, so an
 * earlier arrangement or query never outlives the table settings it was made for.
 */
export type StudioCanvasGridNotice = Readonly<{
  kind: "refused";
  code: "field_unmapped";
  reason: string;
  cause: Readonly<{
    placementAlias: string;
    event: StudioCanvasGridChange["kind"];
    fieldIds: readonly string[];
  }>;
}>;

export const reduceStudioCanvasGrid = (
  held: StudioCanvasGridState | undefined,
  change: StudioCanvasGridChange,
): StudioCanvasGridState | StudioCanvasGridNotice | undefined => {
  const usedFields =
    change.kind === "layout"
      ? change.layout.columns.map((column) => column.fieldId)
      : change.kind === "sort"
        ? change.keys.map((key) => key.fieldId)
        : change.kind === "filter"
          ? [change.fieldId]
          : [];
  if (change.kind === "sort" || change.kind === "filter" || change.kind === "search") {
    const previous = held?.key === change.key ? held.query.query : undefined;
    usedFields.push(
      ...(change.kind === "sort" ? [] : (previous?.sort.map((key) => key.fieldId) ?? [])),
      ...(previous?.filters.map((entry) => entry.fieldId) ?? []),
    );
  }
  const unmapped = usedFields.filter((id) => !change.fields.has(id.toLowerCase()));
  if (unmapped.length > 0)
    return {
      kind: "refused",
      code: "field_unmapped",
      reason:
        "This grid change could not be applied because a field changed. Save the draft and reload the canvas, then try again.",
      cause: { placementAlias: change.placementAlias, event: change.kind, fieldIds: unmapped },
    };
  if (change.kind === "sync")
    return held === undefined || held.currentKey === change.key
      ? held
      : { ...held, currentKey: change.key };
  const base = held?.key === change.key ? held : undefined;
  const next = (
    parts: Partial<Pick<StudioCanvasGridState, "layout" | "query" | "read">>,
  ): StudioCanvasGridState => ({
    placementAlias: change.placementAlias,
    key: change.key,
    currentKey: change.key,
    layout: base?.layout,
    query: base?.query ?? noQuery,
    read: base?.read,
    ...parts,
  });
  const query = (base?.query ?? noQuery).query;
  const changed = (value: StudioCanvasGridQuery): StudioCanvasGridState => {
    const layout = base?.layout;
    return next({
      query: { query: value, state: queryGroup(value, change.fields) },
      read: {
        ...value,
        ...(layout === undefined ? {} : { layout: layout.layout }),
        reread: base?.read?.reread ?? 0,
      },
    });
  };
  switch (change.kind) {
    case "layout":
      return next({
        layout: { layout: change.layout, state: layoutGroup(change.layout, change.fields) },
      });
    case "sort":
      return changed({
        ...query,
        sort: change.keys.map((key) => ({ ...key, fieldId: key.fieldId.toLowerCase() })),
      });
    case "filter": {
      const fieldId = change.fieldId.toLowerCase();
      return changed({
        ...query,
        filters: [
          ...query.filters.filter((entry) => entry.fieldId !== fieldId),
          ...(change.filter === "" ? [] : [{ fieldId, filter: change.filter }]),
        ],
      });
    }
    case "search":
      return changed({ ...query, search: change.text.trim() === "" ? null : change.text.trim() });
    case "refresh":
      return next({
        read: {
          ...query,
          ...(base?.layout === undefined ? {} : { layout: base.layout.layout }),
          reread: (base?.read?.reread ?? 0) + 1,
        },
      });
  }
};

/** The capture the inspector offers: undefined until the grid has reported its layout. */
export const studioCanvasGridArrangement = (
  state: StudioCanvasGridState | undefined,
): StudioCanvasGridArrangement | undefined =>
  state?.layout === undefined
    ? undefined
    : {
        placementAlias: state.placementAlias,
        key: state.key,
        state: {
          kind: "group",
          properties: { ...state.layout.state.properties, ...state.query.state.properties },
        },
      };

/** The reads the preview makes for the grids whose held state still matches their settings. */
export const studioCanvasGridReads = (
  states: ReadonlyMap<string, StudioCanvasGridState>,
): Readonly<Record<string, StudioCanvasGridRead>> =>
  Object.fromEntries(
    [...states].flatMap(([alias, state]) =>
      state.read !== undefined && state.key === state.currentKey ? [[alias, state.read]] : [],
    ),
  );

export const StudioCanvasGridContext = createContext<
  Readonly<{ report: ((change: StudioCanvasGridChange) => void) | undefined; interactive: boolean }>
>({ report: undefined, interactive: false });

/** The canvas uses the grid's normal events; no personal preference is written. */
export function useStudioCanvasGridEvents(
  props: Readonly<Record<string, unknown>>,
  compiled: Readonly<Record<string, unknown>> | undefined,
  release: PlatformBlockRelease | undefined,
): DisplayEventHandlers | undefined {
  const { report, interactive } = useContext(StudioCanvasGridContext);
  const setup =
    report === undefined || compiled === undefined || release === undefined
      ? undefined
      : gridSetup(props, compiled, release);
  // Source settings invalidate held reads before the next compilation/row response arrives; a
  // draft whose settings do not read (the inspector names why) holds no canvas state at all.
  const key =
    release === undefined ? undefined : (gridSource(props, release)?.key ?? UNREADABLE_GRID_KEY);
  const alias = String(props.id);
  // The held state follows the settings the grid has now.
  useEffect(() => {
    if (report !== undefined && key !== undefined)
      report({ kind: "sync", placementAlias: alias, key, fields: new Map() });
  }, [report, alias, key]);
  if (report === undefined || setup === undefined || !interactive) return undefined;
  const { contract, fields } = setup;
  const send = (event: StudioCanvasGridEvent) =>
    report({ ...event, placementAlias: alias, key: setup.key, fields });
  const supports = (event: string): boolean => release!.supportedEvents.includes(event as never);
  return {
    columns_changed: async (event): Promise<GridLayoutCommitResult> => {
      if (event.event !== "columns_changed") return { outcome: "unavailable" };
      // Reset returns to the authored columns and density, through this same event.
      const layout: GridLayout = event.layout ?? {
        columns: contract.columns.map((column) => ({
          fieldId: column.field.toLowerCase(),
          visible: column.visible,
          pin: column.pin,
        })),
        density: contract.density,
      };
      send({
        kind: "layout",
        layout: { ...layout, density: layout.density ?? contract.density },
      });
      return { outcome: "previewed" };
    },
    // The sort, typed filters and search are the grid's own events: each is one protected
    // preview read of the canvas, and the grid never filters or orders the rows it shows.
    ...(supports("sort_changed")
      ? {
          sort_changed: async (event) => {
            if (event.event === "sort_changed") send({ kind: "sort", keys: event.sort });
          },
        }
      : {}),
    ...(supports("filter_changed") && contract.features.columnFilters.enabled
      ? {
          filter_changed: async (event) => {
            if (event.event === "filter_changed")
              send({ kind: "filter", fieldId: event.field, filter: event.value });
          },
        }
      : {}),
    ...(supports("search_changed") && contract.features.search.enabled
      ? {
          search_changed: async (event) => {
            if (event.event === "search_changed") send({ kind: "search", text: event.query });
          },
        }
      : {}),
    // A column shown after the last read makes the one bounded projection read.
    refresh: async () => send({ kind: "refresh" }),
  };
}

/** The key of a grid whose draft settings do not read; no held state ever carries it. */
const UNREADABLE_GRID_KEY = "unreadable";

/**
 * The authored settings identify held state even while its compiled rows are being replaced.
 * Undefined while the draft holds settings that do not read, which the inspector already reports.
 */
const gridSource = (props: Readonly<Record<string, unknown>>, release: PlatformBlockRelease) => {
  const declarations = release.properties.filter(({ key }) =>
    [
      "columns",
      "density",
      "features",
      "query_parameters",
      "sortable_fields",
      "default_sort",
    ].includes(key),
  );
  const normalized = typedSourceSettings(
    Object.fromEntries(
      declarations.flatMap(({ key }) => (props[key] === undefined ? [] : [[key, props[key]]])),
    ),
    declarations,
  );
  if (normalized.failures.length > 0) return undefined;
  const vortex = isRecord(props.vortex) ? props.vortex : {};
  return {
    settings: normalized.settings,
    key: studioCanvasGridKey(
      vortex.query,
      Object.fromEntries(
        Object.entries(normalized.settings).map(([key, value]) => [
          key,
          plainSourceSettingValue(value),
        ]),
      ),
    ),
  };
};

/**
 * The grid's table contract and field names; undefined for a non-table block, and while the
 * compiled table is behind its draft settings (it catches up on the next compilation).
 */
const gridSetup = (
  props: Readonly<Record<string, unknown>>,
  compiled: Readonly<Record<string, unknown>>,
  release: PlatformBlockRelease,
) => {
  const contract = readRecordsTableContract(compiledItemSettings(compiled, release));
  if (contract === undefined) return undefined;
  const sourceColumns = props.columns;
  if (!Array.isArray(sourceColumns) || sourceColumns.length !== contract.columns.length)
    return undefined;
  const fields = new Map<string, string>();
  for (const [index, column] of contract.columns.entries()) {
    const source: unknown = sourceColumns[index];
    if (!isRecord(source) || typeof source.field !== "string") return undefined;
    fields.set(column.field.toLowerCase(), source.field);
  }
  // The inspector reads catalogue defaults too, including defaults inside each column group.
  const source = gridSource(props, release);
  if (source === undefined) return undefined;
  // A filter may name a field the table does not show; the feature lists its fields in the same order.
  const filterFields = contract.features.columnFilters.enabled
    ? contract.features.columnFilters.fields
    : [];
  const features = source.settings.features;
  const sourceFilters =
    features?.kind === "group" && features.properties.column_filters?.kind === "group"
      ? features.properties.column_filters.properties.fields
      : undefined;
  if (filterFields.length > 0) {
    if (sourceFilters?.kind !== "list" || sourceFilters.items.length !== filterFields.length)
      return undefined;
    for (const [index, filterField] of filterFields.entries()) {
      const item = sourceFilters.items[index];
      if (item?.kind !== "field_reference") return undefined;
      fields.set(filterField.toLowerCase(), item.field);
    }
  }
  return {
    contract,
    fields,
    key: source.key,
  };
};
