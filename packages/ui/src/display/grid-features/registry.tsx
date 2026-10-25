"use client";

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import {
  recordsTableBoardFeature,
  recordsTableBulkActionsFeature,
  recordsTableColumnFiltersFeature,
  recordsTableConditionalFormattingFeature,
  recordsTableExportFeature,
  recordsTableGroupingFeature,
  recordsTableInlineEditFeature,
  recordsTableMasterDetailFeature,
  recordsTablePinningFeature,
  recordsTablePivotFeature,
  recordsTableRowActionsFeature,
  recordsTableRowEditFeature,
  recordsTableSavedViewsFeature,
  recordsTableSearchFeature,
  recordsTableSpreadsheetFeature,
  recordsTableTotalsFeature,
  recordsTableTreeFeature,
  type GridLayout,
  type GridViewsState,
  type RecordsTableFeatureKey,
  type RecordsTableFeatureProjection,
  type RecordsTableSortState,
} from "@vortex/platform/schema";
import type { DisplayEventHandlers, DisplayRow, TableNarrowing } from "../projected-data";
import type { RowExpansionKind } from "../row-expansion";
import type { RowLine, SubRowsKind, SubRowsOpen } from "../sub-rows";
import type { TableSelectionParts } from "../projected-grid-features";
import type { GridColumn, GridLayoutControls } from "../table-layout";

/**
 * What every extension point of a grid feature receives: the viewer's feature projection for this
 * read, the page the host read and its handlers. A feature only reads it and reports declared
 * events; the host reads a new page on the server.
 */
export type GridFeatureContext = Readonly<{
  accessibleName: string;
  /** The presentation already selected by the parent Data grid. */
  presentation: "grid" | "cards";
  features: RecordsTableFeatureProjection;
  /** The columns the page carries, in display order. */
  columns: readonly GridColumn[];
  rows: readonly DisplayRow[];
  /**
   * Every row the table draws, in order: the page's rows and the sub-rows and notices beneath the
   * open ones. A cell's `data-row` is its index here.
   */
  lines: readonly RowLine[];
  selectedRecordIds: readonly string[];
  /**
   * The selection beyond the shown page: the read's sealed descriptor of every matching record and
   * the scope and bulk run the page holds. `paged` says the query has pages besides this one.
   */
  selection: TableSelectionParts;
  paged: boolean;
  narrowing: TableNarrowing | undefined;
  /** The order the page was read in, when it is the viewer's own or the authored default. */
  sort: RecordsTableSortState | undefined;
  /** The layout as the person has it now, including a change not yet stored. */
  arrangement: GridLayout;
  /** The saved views of this grid; absent when the grid is not stored for the person. */
  views: GridViewsState | undefined;
  events: DisplayEventHandlers | undefined;
  /** The person's pin per lower-cased field identity, and the one way to change it. */
  pins: GridLayoutControls["state"]["pins"];
  setPin: GridLayoutControls["setPin"];
  /**
   * The pivot view, when the pivot feature is on: `view` is undefined while the ordinary grid is
   * shown, and `setView` opens, pages or closes the pivot and keeps it in the address.
   */
  pivot: GridPivotView | undefined;
  /**
   * The grouping, when the grouping feature is on: whether the table is grouped now, and the one
   * way to group it by the authored field or to show the records ungrouped. The address keeps it.
   */
  grouping: GridGroupingView | undefined;
}>;

export type GridGroupingView = Readonly<{
  grouped: boolean;
  setGrouped: (grouped: boolean) => void;
}>;

export type GridPivotView = Readonly<{
  view: Readonly<{ cursor?: string | undefined }> | undefined;
  setView: (view: Readonly<{ cursor?: string | undefined }> | undefined) => void;
}>;

/** The one grid focus model, shared with optional page interactions. */
export type GridInteractionSurface = Readonly<{
  rootRef: RefObject<HTMLDivElement | null>;
  focusCell: (row: number, columnId: string, focus?: boolean) => void;
}>;
export type GridFeatureInteractionProps = Readonly<{
  context: GridFeatureContext;
  surface: GridInteractionSurface;
}>;

export type GridFeatureScopeProps = Readonly<{
  context: GridFeatureContext;
  children: ReactNode;
  retainRow: (recordId: string | undefined) => void;
}>;
export type GridFeatureCommandProps = Readonly<{ context: GridFeatureContext; row: DisplayRow }>;

export type GridFeaturePointProps = Readonly<{ context: GridFeatureContext }>;
export type GridFeatureColumnProps = Readonly<{ context: GridFeatureContext; column: GridColumn }>;
/**
 * What an expanded row's panel keeps while its row stays open. The table holds it, not the panel, so
 * a panel remounted by a presentation change (grid to phone cards and back) shows what it had
 * instead of reading again; collapsing the row, or the row leaving the page, forgets it.
 */
export type RowPanelMemory = Readonly<{ kept: () => unknown; keep: (value: unknown) => void }>;
export type GridFeatureRowProps = Readonly<{
  context: GridFeatureContext;
  row: DisplayRow;
  memory: RowPanelMemory;
}>;
/**
 * What the controller of a feature that contributes sub-rows receives (see `SubRowsOpen`). The
 * table draws the entries it publishes as rows of its own grid (or cards of its own list).
 */
export type GridFeatureSubRowsProps = SubRowsOpen & Readonly<{ context: GridFeatureContext }>;
/** A cell a feature may draw instead of the plain value; `children` is the plain value. */
export type GridFeatureCellProps = Readonly<{
  context: GridFeatureContext;
  row: DisplayRow;
  column: GridColumn;
  children: ReactNode;
}>;

/**
 * The closed decoration tokens a feature may give a cell; each maps to semantic theme-token
 * classes, so every app theme preset colours them and no feature names a colour of its own.
 */
const gridCellDecorationClasses = {
  text_success: "text-success",
  text_warning: "text-warning",
  text_info: "text-info",
  text_destructive: "text-[color:color-mix(in_oklab,var(--destructive)_75%,var(--foreground))]",
  text_muted: "text-[color:color-mix(in_oklab,var(--muted-foreground)_85%,var(--foreground))]",
  bold: "font-semibold",
  strike: "line-through",
} as const;
export type GridCellDecorationToken = keyof typeof gridCellDecorationClasses;

/**
 * The grid features that fill extension points of the table. Board is not one: it replaces the
 * table with the board view as a whole, which the Data grid draws itself.
 */
type GridExtensionKey = Exclude<RecordsTableFeatureKey, "board">;

/** Whole-grid views share the lazy registry but do not fill table extension points. */
const viewLoaders = {
  [recordsTableBoardFeature.key]: () => import("../board"),
} satisfies Record<typeof recordsTableBoardFeature.key, () => Promise<unknown>>;

export const GridBoardView = lazy(async () => ({
  default: (await viewLoaders[recordsTableBoardFeature.key]()).BoardView,
}));

/**
 * The extension points a grid feature fills. The table renders each point once for every feature
 * the projection turns on, so a later feature adds its module here and never edits the table:
 * `ToolbarItems` beside the search box, `ColumnMenuItems` in a column's menu, `HeaderAdornment`
 * after a column heading, `cellDecoration` as tokens per cell, `CellAdornment` around a value (an
 * icon, a badge or a bar), `CellEditor` in place of a value, `RowExpansion` as a panel below a row,
 * `SubRows` as the controller of rows the table draws beneath an open row (it draws nothing itself:
 * it reports entries, and the grid draws them as its own rows) and `SelectionBanner` over the
 * selected rows.
 */
export type GridFeatureModule = Readonly<{
  Scope?: ComponentType<GridFeatureScopeProps>;
  RowCommands?: ComponentType<GridFeatureCommandProps>;
  RowEditor?: ComponentType<GridFeatureCommandProps>;
  GridInteraction?: ComponentType<GridFeatureInteractionProps>;
  ToolbarItems?: ComponentType<GridFeaturePointProps>;
  ColumnMenuItems?: ComponentType<GridFeatureColumnProps>;
  HeaderAdornment?: ComponentType<GridFeatureColumnProps>;
  cellDecoration?: (
    context: GridFeatureContext,
    row: DisplayRow,
    column: GridColumn,
  ) => readonly GridCellDecorationToken[] | undefined;
  CellAdornment?: ComponentType<GridFeatureCellProps>;
  CellEditor?: ComponentType<GridFeatureCellProps>;
  RowExpansion?: ComponentType<GridFeatureRowProps>;
  SubRows?: ComponentType<GridFeatureSubRowsProps>;
  SelectionBanner?: ComponentType<GridFeaturePointProps>;
  /** The view that takes the place of the rows while the feature's view is open (the pivot). */
  ViewBody?: ComponentType<GridFeaturePointProps>;
}>;

type ComponentPoint = Exclude<keyof GridFeatureModule, "cellDecoration">;

/**
 * One grid feature's view, keyed by the feature's own definition: its code, a dynamic import that
 * is a chunk of its own downloaded only when the projection turns the feature on for this viewer
 * (a table with every feature off loads none), the extension points it fills, and what a row opens
 * to when the feature draws below rows.
 */
type GridFeatureView = Readonly<{
  definition: Readonly<{ key: GridExtensionKey; property: string }>;
  load: () => Promise<{ gridFeature: GridFeatureModule }>;
  points: readonly ComponentPoint[];
  /** What a row opens to when the feature fills the row panel. */
  expansion?: RowExpansionKind;
  /** What a row opens to when the feature contributes the rows beneath it. */
  subRows?: SubRowsKind;
}>;

const gridFeatureViews: readonly GridFeatureView[] = [
  {
    definition: recordsTablePinningFeature,
    load: () => import("./pinning"),
    points: ["ColumnMenuItems"],
  },
  {
    definition: recordsTableSpreadsheetFeature,
    load: () => import("./spreadsheet"),
    points: ["GridInteraction"],
  },
  {
    definition: recordsTableSearchFeature,
    load: () => import("./search"),
    points: ["ToolbarItems"],
  },
  {
    definition: recordsTableColumnFiltersFeature,
    load: () => import("./column-filters"),
    points: ["ToolbarItems", "HeaderAdornment"],
  },
  {
    definition: recordsTableSavedViewsFeature,
    load: () => import("./saved-views"),
    points: ["ToolbarItems"],
  },
  {
    definition: recordsTableBulkActionsFeature,
    load: () => import("./bulk-actions"),
    points: ["SelectionBanner"],
  },
  {
    definition: recordsTableInlineEditFeature,
    load: () => import("./inline-edit"),
    points: ["CellEditor"],
  },
  {
    definition: recordsTableRowEditFeature,
    load: () => import("./row-editor"),
    points: ["Scope", "CellEditor", "RowCommands", "RowEditor", "ToolbarItems"],
  },
  {
    definition: recordsTableRowActionsFeature,
    load: () => import("./row-actions"),
    points: ["RowCommands", "GridInteraction"],
  },
  {
    definition: recordsTableMasterDetailFeature,
    load: () => import("./master-detail"),
    points: ["RowExpansion"],
    // A row opens to its related records, at most three at a time.
    expansion: { noun: "related records", maximum: 3, expandable: () => true },
  },
  {
    definition: recordsTableTreeFeature,
    load: () => import("./tree"),
    points: ["SubRows"],
    // The rows beneath a row share the feature's row budget, so any number of rows may be open, and
    // only a row the server says has children offers the toggle.
    subRows: { noun: "child records", expandable: (row) => row.hasChildren !== undefined },
  },
  {
    definition: recordsTableGroupingFeature,
    load: () => import("./grouping"),
    points: ["ToolbarItems", "ColumnMenuItems"],
  },
  {
    definition: recordsTableTotalsFeature,
    load: () => import("./totals"),
    points: ["ToolbarItems"],
  },
  {
    definition: recordsTableConditionalFormattingFeature,
    load: () => import("./conditional-format"),
    points: ["CellAdornment", "HeaderAdornment"],
  },
  {
    definition: recordsTablePivotFeature,
    load: () => import("./pivot"),
    points: ["ToolbarItems", "ViewBody"],
  },
  {
    definition: recordsTableExportFeature,
    load: () => import("./export"),
    points: ["ToolbarItems", "SelectionBanner"],
  },
];

const viewOf = new Map(gridFeatureViews.map((view) => [view.definition.key, view]));
const loaders = Object.fromEntries(
  gridFeatureViews.map((view) => [view.definition.key, view.load]),
) as Readonly<Record<GridExtensionKey, GridFeatureView["load"]>>;
const featurePoints = Object.fromEntries(
  gridFeatureViews.map((view) => [view.definition.key, view.points]),
) as Readonly<Record<GridExtensionKey, readonly ComponentPoint[]>>;

/** The features a projection turns on, in the registry's order. */
const projectedGridFeatures = (
  features: RecordsTableFeatureProjection | undefined,
): readonly GridExtensionKey[] =>
  features === undefined
    ? []
    : gridFeatureViews
        .filter(
          (view) =>
            features[view.definition.property as keyof RecordsTableFeatureProjection] !== undefined,
        )
        .map((view) => view.definition.key);

const noDecorators: readonly NonNullable<GridFeatureModule["cellDecoration"]>[] = [];
const Nothing = (): null => null;
const PassThrough = ({ children }: Readonly<{ children?: ReactNode }>): ReactElement => (
  <>{children}</>
);

/** Exported code only: cached points never hold a viewer's data or access decisions. */
const pointComponents = new Map<string, ComponentType<object>>();
const pointComponentOf = (
  module: GridFeatureModule,
  point: ComponentPoint,
): ComponentType<object> =>
  (module[point] ??
    (point === "CellEditor" || point === "CellAdornment"
      ? PassThrough
      : Nothing)) as unknown as ComponentType<object>;

const featurePoint = <Props,>(
  key: GridExtensionKey,
  point: ComponentPoint,
): ComponentType<Props> => {
  const id = `${key}:${point}`;
  const held = pointComponents.get(id);
  const component =
    held ??
    lazy(async () => {
      try {
        return { default: pointComponentOf((await loaders[key]()).gridFeature, point) };
      } catch (error) {
        // A feature whose code cannot be downloaded leaves the grid usable without it; the next
        // render tries again.
        console.error(`[display] grid feature ${key} could not be loaded`, error);
        pointComponents.delete(id);
        const fallback =
          point === "CellEditor" || point === "CellAdornment" ? PassThrough : Nothing;
        return { default: fallback as unknown as ComponentType<object> };
      }
    });
  if (held === undefined) pointComponents.set(id, component);
  return component as unknown as ComponentType<Props>;
};

/** What the projected feature's sub-rows hold; undefined when no feature contributes any. */
export const subRowsKindOf = (
  features: RecordsTableFeatureProjection | undefined,
): SubRowsKind | undefined =>
  projectedGridFeatures(features)
    .map((key) => viewOf.get(key)?.subRows)
    .find((kind) => kind !== undefined);

const activeKeys = (signature: string): readonly GridExtensionKey[] =>
  signature === "" ? [] : (signature.split(",") as GridExtensionKey[]);

/** One Suspense boundary per active feature that fills the point. */
const drawPoint = (
  active: readonly GridExtensionKey[],
  point: ComponentPoint,
  context: GridFeatureContext,
  props: Record<string, unknown>,
): ReactNode =>
  active
    .filter((key) => featurePoints[key].includes(point))
    .map((key) => {
      const Point = featurePoint<Record<string, unknown>>(key, point);
      return (
        <Suspense key={key} fallback={null}>
          <Point context={context} {...props} />
        </Suspense>
      );
    });

/**
 * The one hook the Records table calls. It returns the renderers of every extension point for the
 * features the projection turns on; with no projection every renderer draws nothing and no feature
 * code is loaded.
 */
export function useGridFeatures(context: GridFeatureContext | undefined): Readonly<{
  keys: readonly GridExtensionKey[];
  scope: (children: ReactNode) => ReactNode;
  rowCommands: (row: DisplayRow) => ReactNode;
  rowEditor: (row: DisplayRow) => ReactNode;
  retainedRecordIds: readonly string[];
  /** A projected feature draws a panel below an expanded row, so rows offer an expand toggle. */
  expands: boolean;
  /** What that panel holds and how many may be open; undefined when no feature draws one. */
  expansionKind: RowExpansionKind | undefined;
  /** The controller of the sub-rows, drawn once; it draws nothing and reports through `publish`. */
  subRowsController: (open: SubRowsOpen) => ReactNode;
  toolbarItems: () => ReactNode;
  interaction: (surface: GridInteractionSurface) => ReactNode;
  selectionBanner: () => ReactNode;
  headerAdornment: (column: GridColumn) => ReactNode;
  columnMenuItems: (column: GridColumn) => ReactNode;
  rowExpansion: (row: DisplayRow, memory: RowPanelMemory) => ReactNode;
  /** The open view that replaces the rows (the pivot); nothing when no feature has one open. */
  viewBody: () => ReactNode;
  cell: (row: DisplayRow, column: GridColumn, plain: ReactNode) => ReactNode;
  /** A value with its decorations and adornments only, for surfaces that never edit (cards). */
  decorate: (row: DisplayRow, column: GridColumn, plain: ReactNode) => ReactNode;
  cellClassName: (row: DisplayRow, column: GridColumn) => string | undefined;
}> {
  const [retainedRow, setRetainedRow] = useState<string | undefined>(undefined);
  const retainRow = useCallback((recordId: string | undefined) => setRetainedRow(recordId), []);
  const keys = projectedGridFeatures(context?.features);
  const signature = keys.join(",");
  // Cell decorations are plain functions, not components: their modules are read once loaded.
  // They are held with the feature set they were loaded for, so another projection never uses them.
  const [loadedDecorators, setLoadedDecorators] = useState<
    Readonly<{
      signature: string;
      decorators: readonly NonNullable<GridFeatureModule["cellDecoration"]>[];
    }>
  >({ signature: "", decorators: [] });
  const decorators =
    loadedDecorators.signature === signature ? loadedDecorators.decorators : noDecorators;
  useEffect(() => {
    if (signature === "") return;
    let current = true;
    void Promise.all(signature.split(",").map((key) => loaders[key as GridExtensionKey]())).then(
      (modules) => {
        // An enabled feature is already downloaded here. Keep its concrete points so opening a
        // panel later does not introduce another asynchronous boundary and Suspense delay.
        modules.forEach((module, index) => {
          const key = activeKeys(signature)[index]!;
          for (const point of featurePoints[key]) {
            const id = `${key}:${point}`;
            // Keep an already mounted editor's component identity and local edit state.
            if (!pointComponents.has(id))
              pointComponents.set(id, pointComponentOf(module.gridFeature, point));
          }
        });
        if (current)
          setLoadedDecorators({
            signature,
            decorators: modules.flatMap((module) => module.gridFeature.cellDecoration ?? []),
          });
      },
      (error: unknown) => {
        console.error("[display] a grid feature could not be loaded", error);
      },
    );
    return () => {
      current = false;
    };
  }, [signature]);
  // The points drawn inside the grid's memoized rows and headers keep their identity while only
  // the page's rows or the selection change, so a new selection never redraws every row; they read
  // the latest context when they draw.
  const latest = useRef(context);
  latest.current = context;
  const features = context?.features;
  const events = context?.events;
  const columns = context?.columns;
  const accessibleName = context?.accessibleName;
  const cellPoints = useMemo(() => {
    const active = activeKeys(signature);
    const editors = active.filter((key) => featurePoints[key].includes("CellEditor"));
    const adornments = active.filter((key) => featurePoints[key].includes("CellAdornment"));
    // Adornments wrap the plain value inside any editor, so an edited cell keeps its icon or bar.
    const adorn = (row: DisplayRow, column: GridColumn, plain: ReactNode): ReactNode => {
      const current = latest.current;
      if (current === undefined) return plain;
      return adornments.reduce<ReactNode>((inner, key) => {
        const Adornment = featurePoint<GridFeatureCellProps>(key, "CellAdornment");
        return (
          <Suspense key={key} fallback={inner}>
            <Adornment context={current} row={row} column={column}>
              {inner}
            </Adornment>
          </Suspense>
        );
      }, plain);
    };
    const classNameOf = (row: DisplayRow, column: GridColumn): string | undefined => {
      const current = latest.current;
      if (current === undefined || decorators.length === 0) return undefined;
      const classes = decorators.flatMap((decorate) =>
        (decorate(current, row, column) ?? []).map((token) => gridCellDecorationClasses[token]),
      );
      return classes.length === 0 ? undefined : classes.join(" ");
    };
    const drawAt = (point: ComponentPoint, props: Record<string, unknown>): ReactNode => {
      const current = latest.current;
      return current === undefined ? null : drawPoint(active, point, current, props);
    };
    return {
      rowCommands: (row: DisplayRow) => drawAt("RowCommands", { row }),
      rowEditor: (row: DisplayRow) => drawAt("RowEditor", { row }),
      interaction: (surface: GridInteractionSurface) => drawAt("GridInteraction", { surface }),
      headerAdornment: (column: GridColumn) => drawAt("HeaderAdornment", { column }),
      columnMenuItems: (column: GridColumn) => drawAt("ColumnMenuItems", { column }),
      rowExpansion: (row: DisplayRow, memory: RowPanelMemory) =>
        drawAt("RowExpansion", { row, memory }),
      subRowsController: (open: SubRowsOpen) => drawAt("SubRows", open),
      decorate: (row: DisplayRow, column: GridColumn, plain: ReactNode): ReactNode => {
        const decoration = classNameOf(row, column);
        return adorn(
          row,
          column,
          decoration === undefined ? plain : <span className={decoration}>{plain}</span>,
        );
      },
      cell: (row: DisplayRow, column: GridColumn, plain: ReactNode): ReactNode => {
        const current = latest.current;
        if (current === undefined) return plain;
        return editors.reduce<ReactNode>(
          (inner, key) => {
            const Editor = featurePoint<GridFeatureCellProps>(key, "CellEditor");
            return (
              <Suspense key={key} fallback={inner}>
                <Editor context={current} row={row} column={column}>
                  {inner}
                </Editor>
              </Suspense>
            );
          },
          adorn(row, column, plain),
        );
      },
      cellClassName: classNameOf,
    };
    // The cell points change with the projection, bindings and columns, not with rows or selection.
  }, [signature, decorators, features, events, columns, accessibleName]);
  const active = activeKeys(signature);
  return {
    keys: active,
    retainedRecordIds: retainedRow === undefined ? [] : [retainedRow],
    scope: (children) =>
      context === undefined
        ? children
        : active
            .filter((key) => featurePoints[key].includes("Scope"))
            .reduce<ReactNode>((inner, key) => {
              const Scope = featurePoint<GridFeatureScopeProps>(key, "Scope");
              return (
                <Suspense key={key} fallback={inner}>
                  <Scope context={context} retainRow={retainRow}>
                    {inner}
                  </Scope>
                </Suspense>
              );
            }, children),
    expands: active.some((key) => featurePoints[key].includes("RowExpansion")),
    expansionKind: active
      .map((key) => viewOf.get(key)?.expansion)
      .find((kind) => kind !== undefined),
    toolbarItems: () =>
      context === undefined ? null : drawPoint(active, "ToolbarItems", context, {}),
    selectionBanner: () =>
      context === undefined ? null : drawPoint(active, "SelectionBanner", context, {}),
    viewBody: () => (context === undefined ? null : drawPoint(active, "ViewBody", context, {})),
    ...cellPoints,
  };
}
