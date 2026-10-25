"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import {
  RECORDS_TABLE_COLUMN_MAXIMUM_WIDTH,
  RECORDS_TABLE_COLUMN_MINIMUM_WIDTH,
  authoredGridLayout,
  resolveGridLayout,
  type GridLayout,
  type GridLayoutCommitResult,
  type GridLayoutState,
  type RecordsTableColumnContract,
  type RecordsTableColumnPin,
  type RecordsTableContract,
  type RecordsTableDensity,
} from "@vortex/platform/schema";
import type { DisplayColumn, DisplayEventHandlers } from "./projected-data";
import { columnWidth } from "./table-geometry";

/** One column the page carries: its field, heading, declaration and authored starting width. */
export type GridColumn = Readonly<{
  key: string;
  label: string;
  declared: RecordsTableColumnContract;
  sortable: boolean;
  width: number;
}>;

/** One declared column as the Columns menu lists it: shown or hidden, in display order. */
export type GridLayoutEntry = Readonly<{ key: string; label: string; visible: boolean }>;

export type GridLayoutControls = Readonly<{
  /** The shown columns the page carries, in declared order. */
  columns: readonly GridColumn[];
  /** The shown columns in display order and their widths in pixels. */
  state: Readonly<{
    order: readonly string[];
    widths: Readonly<Record<string, number>>;
    pins: Readonly<Record<string, RecordsTableColumnPin>>;
  }>;
  /** The shown columns in display order. */
  shown: readonly GridColumn[];
  /** Every declared column, shown or hidden, in display order. */
  entries: readonly GridLayoutEntry[];
  density: RecordsTableDensity;
  /**
   * Whether the host receives the person's changes, stored for them or reported to the Studio
   * canvas; the host then reads a newly shown column. In a preview they stay on screen only.
   */
  persisted: boolean;
  /** Whether the layout is the Studio canvas arrangement, which exists even before any row is read. */
  canvas: boolean;
  /** Sets widths while a resize is under way; `commit` stores them once it ends. */
  setWidths: (update: SetStateAction<Readonly<Record<string, number>>>) => void;
  commit: () => void;
  /** Moves a shown column by an offset; returns its new 1-based position among shown columns. */
  moveColumn: (key: string, offset: number) => number | undefined;
  setVisible: (key: string, visible: boolean) => void;
  setDensity: (density: RecordsTableDensity) => void;
  setPin: (key: string, pin: RecordsTableColumnPin) => void;
  /** Returns to the authored layout and removes the person's stored one. */
  reset: () => void;
  /** Whether the layout differs from the authored one. */
  arranged: boolean;
  /** The layout as the person has it now, including a change not yet stored. */
  arrangement: GridLayout;
}>;

/** Changes from one gesture are stored together once the person pauses (keyboard resizes repeat). */
const COMMIT_DELAY_MS = 400;

const sameLayout = (left: GridLayout, right: GridLayout): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const clampWidth = (width: number): number =>
  Math.round(
    Math.max(
      RECORDS_TABLE_COLUMN_MINIMUM_WIDTH,
      Math.min(RECORDS_TABLE_COLUMN_MAXIMUM_WIDTH, width),
    ),
  );

type Local = Readonly<{
  /** The stored layout state this local copy started from; a new page read starts it again. */
  base: GridLayoutState;
  /** Which authored columns and density the canvas arrangement started from. */
  definition: string;
  layout: GridLayout;
  /** The last completed gesture; a pending write never captures an in-progress resize. */
  committedLayout: GridLayout;
  revision: number | null;
  /** Bumped by every change the person committed; each bump schedules one coalesced store. */
  commits: number;
  savedCommits: number;
  /** The committed change is a reset: the stored layout is removed rather than written. */
  resetting: boolean;
}>;

const startFrom = (base: GridLayoutState, definition: string): Local => ({
  base,
  definition,
  layout: base.layout,
  committedLayout: base.layout,
  revision: base.revision,
  commits: base.reset && base.storage === "personal" ? 1 : 0,
  savedCommits: 0,
  resetting: base.reset,
});

/**
 * The person's layout of one grid: column order, which columns show, widths and density. It starts
 * from the stored layout the page was read with and changes on screen at once, reading nothing;
 * every committed gesture is stored once, coalesced, at the revision it was made from. Showing a
 * column the page was read without makes the host read the grid again after the store (the only
 * read a layout change causes). A newer layout from another tab wins: it is shown and the host
 * says so.
 */
export const useGridLayout = ({
  contract,
  carried,
  declared,
  stored,
  events,
  pinning,
}: Readonly<{
  contract: RecordsTableContract | undefined;
  /** The columns the page was read with, in declared order. */
  carried: readonly GridColumn[];
  /** Every declared column the viewer may see, with its heading. */
  declared: readonly DisplayColumn[];
  stored: GridLayoutState | undefined;
  events: DisplayEventHandlers | undefined;
  /** The viewer's projection turns column pinning on. */
  pinning: boolean;
}>): GridLayoutControls => {
  const fallback = useMemo((): GridLayoutState | undefined => {
    const authored = contract === undefined ? undefined : authoredGridLayout(contract);
    // Before the page is read there is nothing to store; the authored layout shows.
    return authored === undefined
      ? undefined
      : {
          storage: "preview",
          queryId: "",
          revision: null,
          layout: authored,
          authored,
          reset: false,
        };
  }, [contract]);
  const source = stored ?? fallback;
  const canvasDefinition =
    source?.storage === "canvas" ? JSON.stringify([contract?.columns, contract?.density]) : "";
  const [local, setLocal] = useState<Local | undefined>(() =>
    source === undefined ? undefined : startFrom(source, canvasDefinition),
  );
  // A new page read carries the stored layout again; the local copy starts over from it.
  let current = local;
  if (source !== undefined && current?.base !== source) {
    // The canvas reparses the same payload when its inspector receives a gesture. That is not a
    // new authored arrangement: keep the transient layout until its actual definition changes.
    const sameCanvas =
      current !== undefined &&
      source.storage === "canvas" &&
      current.base.storage === "canvas" &&
      current.definition === canvasDefinition &&
      current.base.queryId === source.queryId &&
      sameLayout(current.base.layout, source.layout) &&
      sameLayout(current.base.authored, source.authored);
    // A projection read may finish after another gesture. Keep that unsaved gesture while
    // adopting the read's revision; its values are still persisted through the same writer.
    current =
      current !== undefined &&
      (sameCanvas ||
        (source.storage === "personal" &&
          current.base.storage === "personal" &&
          current.base.queryId === source.queryId &&
          current.commits > current.savedCommits))
        ? { ...current, base: source, definition: canvasDefinition, revision: source.revision }
        : startFrom(source, canvasDefinition);
    setLocal(current);
  }
  const layout = current?.layout ?? { columns: [] };
  const latest = useRef({ current, carried, events });
  latest.current = { current, carried, events };
  const updateLocal = useCallback((update: (held: Local | undefined) => Local | undefined) => {
    const next = update(latest.current.current);
    latest.current.current = next;
    setLocal(next);
  }, []);

  const carriedByKey = useMemo(
    () => new Map(carried.map((column) => [column.key.toLowerCase(), column])),
    [carried],
  );
  const labels = useMemo(
    () => new Map(declared.map((column) => [column.key.toLowerCase(), column.label])),
    [declared],
  );
  const shownFields = layout.columns
    .filter((entry) => entry.visible)
    .map((entry) => entry.fieldId)
    .join(",");
  const shown = useMemo(
    () =>
      shownFields.split(",").flatMap((fieldId): GridColumn[] => {
        const column = carriedByKey.get(fieldId);
        return column === undefined ? [] : [column];
      }),
    [shownFields, carriedByKey],
  );
  const columns = useMemo(
    () => carried.filter((column) => shown.includes(column)),
    [carried, shown],
  );
  const widths = useMemo(
    () =>
      Object.fromEntries(
        shown.map((column) => [
          column.key,
          layout.columns.find((entry) => entry.fieldId === column.key.toLowerCase())?.width ??
            columnWidth(column.declared),
        ]),
      ),
    [layout, shown],
  );
  // Keyed by the pins alone, so a resize or reorder never hands the grid features a new pin map.
  const pinSignature = layout.columns.map((entry) => `${entry.fieldId}:${entry.pin}`).join(",");
  const pins = useMemo(
    () =>
      Object.fromEntries(
        pinSignature.split(",").map((entry) => entry.split(":") as [string, RecordsTableColumnPin]),
      ),
    [pinSignature],
  );
  const order = useMemo(() => {
    const keys = shown.map((column) => column.key);
    if (!pinning) return keys;
    return ["start", "unpinned", "end"].flatMap((pin) =>
      keys.filter((key) => pins[key.toLowerCase()] === pin),
    );
  }, [shown, pins, pinning]);
  const entries = useMemo(
    () =>
      layout.columns.flatMap((entry): GridLayoutEntry[] => {
        const label = labels.get(entry.fieldId);
        return label === undefined ? [] : [{ key: entry.fieldId, label, visible: entry.visible }];
      }),
    [layout, labels],
  );

  const change = useCallback(
    (update: (layout: GridLayout) => GridLayout | undefined, commit: boolean) =>
      updateLocal((held) => {
        if (held === undefined) return held;
        const next = update(held.layout);
        if (next === undefined || (sameLayout(next, held.layout) && !commit)) return held;
        return {
          ...held,
          layout: next,
          ...(commit ? { committedLayout: next, commits: held.commits + 1, resetting: false } : {}),
        };
      }),
    [updateLocal],
  );

  const setWidths = useCallback(
    (update: SetStateAction<Readonly<Record<string, number>>>) =>
      change((held) => {
        const before = Object.fromEntries(
          held.columns.flatMap((entry) => {
            const column = carriedByKey.get(entry.fieldId);
            return column === undefined
              ? []
              : [[column.key, entry.width ?? columnWidth(column.declared)]];
          }),
        );
        const next = typeof update === "function" ? update(before) : update;
        return {
          ...held,
          columns: held.columns.map((entry) => {
            const column = carriedByKey.get(entry.fieldId);
            if (column === undefined) return entry;
            // A width the update leaves out returns to the authored width.
            if (!(column.key in next)) {
              const rest = { ...entry };
              delete rest.width;
              return rest;
            }
            const width = next[column.key];
            return width === undefined || width === before[column.key]
              ? entry
              : { ...entry, width: clampWidth(width) };
          }),
        };
      }, false),
    [change, carriedByKey],
  );
  const commit = useCallback(
    () =>
      updateLocal((held) =>
        held === undefined
          ? held
          : { ...held, committedLayout: held.layout, commits: held.commits + 1, resetting: false },
      ),
    [updateLocal],
  );
  const moveColumn = useCallback(
    (key: string, offset: number): number | undefined => {
      const from = order.indexOf(key);
      if (from < 0) return undefined;
      const to = Math.max(0, Math.min(order.length - 1, from + offset));
      if (from === to) return from + 1;
      const target = order[to]!.toLowerCase();
      const moved = key.toLowerCase();
      // A move never silently changes a pin; move within the same group or choose a new pin. A refused
      // move answers undefined so nothing is announced as moved.
      if (pinning && pins[target] !== pins[moved]) return undefined;
      change((held) => {
        const rest = held.columns.filter((entry) => entry.fieldId !== moved);
        const entry = held.columns.find((candidate) => candidate.fieldId === moved);
        const at = rest.findIndex((candidate) => candidate.fieldId === target);
        if (entry === undefined || at < 0) return undefined;
        rest.splice(offset > 0 ? at + 1 : at, 0, entry);
        return { ...held, columns: rest };
      }, true);
      return to + 1;
    },
    [change, order, pinning, pins],
  );
  const setPin = useCallback(
    (key: string, pin: RecordsTableColumnPin) => {
      if (!pinning) return;
      change(
        (held) => ({
          ...held,
          columns: held.columns.map((entry) =>
            entry.fieldId === key.toLowerCase() ? { ...entry, pin } : entry,
          ),
        }),
        true,
      );
    },
    [change, pinning],
  );
  const setVisible = useCallback(
    (key: string, visible: boolean) =>
      change((held) => {
        const columns = held.columns.map((entry) =>
          entry.fieldId === key.toLowerCase() ? { ...entry, visible } : entry,
        );
        // At least one column always stays shown.
        return columns.some((entry) => entry.visible) ? { ...held, columns } : undefined;
      }, true),
    [change],
  );
  const setDensity = useCallback(
    (density: RecordsTableDensity) =>
      change((held) => {
        if (contract === undefined) return undefined;
        // The authored density is not stored: a later authored change then still applies.
        return density === contract.density
          ? { columns: held.columns }
          : { columns: held.columns, density };
      }, true),
    [change, contract],
  );
  const reset = useCallback(
    () =>
      updateLocal((held) =>
        held === undefined
          ? held
          : {
              ...held,
              layout: held.base.authored,
              committedLayout: held.base.authored,
              commits: held.commits + 1,
              resetting: true,
            },
      ),
    [updateLocal],
  );

  // Stores committed changes: one write at a time, the latest layout after the person pauses.
  const writer = useRef<{
    timer: ReturnType<typeof setTimeout> | undefined;
    busy: boolean;
  }>({
    timer: undefined,
    busy: false,
  });
  const store = useCallback(async (): Promise<void> => {
    const held = writer.current;
    if (held.busy) {
      return;
    }
    const { current: snapshot, carried: loaded, events: handlers } = latest.current;
    const onColumns = handlers?.columns_changed;
    // An application preview keeps the arrangement on screen: nothing is reported or stored.
    if (snapshot === undefined || snapshot.base.storage === "preview" || onColumns === undefined)
      return;
    const loadedKeys = new Set(loaded.map((column) => column.key.toLowerCase()));
    held.busy = true;
    let result: GridLayoutCommitResult = { outcome: "unavailable" };
    try {
      const outcome = await onColumns({
        event: "columns_changed",
        layout: snapshot.resetting ? null : snapshot.committedLayout,
        expectedRevision: snapshot.revision,
        queryId: snapshot.base.queryId,
      });
      if (typeof outcome === "object" && outcome !== null && "outcome" in outcome)
        result = outcome as GridLayoutCommitResult;
    } finally {
      held.busy = false;
    }
    // A response from an earlier page must never overwrite the new page's layout or revision.
    if (latest.current.current?.base !== snapshot.base) return;
    if (
      result.outcome === "saved" ||
      result.outcome === "reset" ||
      result.outcome === "previewed"
    ) {
      const revision =
        result.outcome === "previewed"
          ? snapshot.revision
          : result.outcome === "saved"
            ? result.revision
            : null;
      updateLocal((latestLocal) =>
        latestLocal === undefined
          ? latestLocal
          : {
              ...latestLocal,
              revision,
              savedCommits: snapshot.commits,
            },
      );
    } else if (result.outcome === "conflict") {
      // Another tab stored a newer layout first: show it, from its revision.
      const adopted = resolveGridLayout(
        snapshot.base.authored,
        result.stored ?? undefined,
        snapshot.base.queryId,
      ).layout;
      updateLocal((latestLocal) =>
        latestLocal === undefined
          ? latestLocal
          : {
              ...latestLocal,
              layout: adopted,
              committedLayout: adopted,
              revision: result.stored?.revision ?? null,
              savedCommits: latestLocal.commits,
              resetting: false,
            },
      );
      if (held.timer !== undefined) clearTimeout(held.timer);
      held.timer = undefined;
    }
    const pending = latest.current.current;
    if (
      (result.outcome === "saved" ||
        result.outcome === "reset" ||
        result.outcome === "previewed") &&
      pending !== undefined &&
      pending.commits > snapshot.commits
    ) {
      if (held.timer !== undefined) clearTimeout(held.timer);
      held.timer = undefined;
      await store();
    } else if (
      result.outcome !== "unavailable" &&
      pending?.layout.columns.some((entry) => entry.visible && !loadedKeys.has(entry.fieldId))
    ) {
      void handlers?.refresh?.({ event: "refresh" });
    }
  }, [updateLocal]);
  // Entering canvas arrangement accepts its starting layout too, including a grid with no rows.
  // It uses the same event as later gestures, so capture never falls back to inspector settings.
  const canvasSource =
    source?.storage === "canvas" && events?.columns_changed !== undefined
      ? `${source.queryId}:${canvasDefinition}`
      : undefined;
  const reportedCanvas = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (canvasSource === undefined) {
      reportedCanvas.current = undefined;
      return;
    }
    if (reportedCanvas.current === canvasSource) return;
    reportedCanvas.current = canvasSource;
    void store();
  }, [canvasSource, store]);
  const commits = current?.commits ?? 0;
  useEffect(() => {
    const storage = latest.current.current?.base.storage;
    if (commits === 0 || storage === "preview") return;
    // Capture must see the completed canvas gesture before the next click; only personal writes
    // need the coalescing delay. Both hosts still receive the same committed-layout event.
    if (storage === "canvas") {
      void store();
      return;
    }
    const held = writer.current;
    if (held.timer !== undefined) clearTimeout(held.timer);
    held.timer = setTimeout(() => {
      held.timer = undefined;
      void store();
    }, COMMIT_DELAY_MS);
  }, [commits, store]);
  // Leaving the page within the coalescing delay still stores the last change.
  const storeRef = useRef(store);
  storeRef.current = store;
  useEffect(
    () => () => {
      const held = writer.current;
      if (held.timer === undefined) return;
      clearTimeout(held.timer);
      held.timer = undefined;
      void storeRef.current();
    },
    [],
  );

  const authored = current?.base.authored;
  const arranged = authored !== undefined && !sameLayout(layout, authored);
  return {
    columns,
    state: { order, widths, pins },
    shown,
    entries,
    density: layout.density ?? contract?.density ?? "comfortable",
    persisted: source?.storage === "personal" || source?.storage === "canvas",
    canvas: source?.storage === "canvas",
    setWidths,
    commit,
    moveColumn,
    setVisible,
    setDensity,
    setPin,
    reset,
    arranged,
    arrangement: layout,
  };
};
