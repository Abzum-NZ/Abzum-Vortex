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
  state: Readonly<{ order: readonly string[]; widths: Readonly<Record<string, number>> }>;
  /** The shown columns in display order. */
  shown: readonly GridColumn[];
  /** Every declared column, shown or hidden, in display order. */
  entries: readonly GridLayoutEntry[];
  density: RecordsTableDensity;
  /** Whether the person's changes are stored for them; in a preview they stay on screen only. */
  persisted: boolean;
  /** Sets widths while a resize is under way; `commit` stores them once it ends. */
  setWidths: (update: SetStateAction<Readonly<Record<string, number>>>) => void;
  commit: () => void;
  /** Moves a shown column by an offset; returns its new 1-based position among shown columns. */
  moveColumn: (key: string, offset: number) => number | undefined;
  setVisible: (key: string, visible: boolean) => void;
  setDensity: (density: RecordsTableDensity) => void;
  /** Returns to the authored layout and removes the person's stored one. */
  reset: () => void;
  /** Whether the layout differs from the authored one. */
  arranged: boolean;
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
  layout: GridLayout;
  revision: number | null;
  /** Bumped by every change the person committed; each bump schedules one coalesced store. */
  commits: number;
  /** The committed change is a reset: the stored layout is removed rather than written. */
  resetting: boolean;
}>;

const startFrom = (base: GridLayoutState): Local => ({
  base,
  layout: base.layout,
  revision: base.revision,
  commits: 0,
  resetting: false,
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
}: Readonly<{
  contract: RecordsTableContract | undefined;
  /** The columns the page was read with, in declared order. */
  carried: readonly GridColumn[];
  /** Every declared column the viewer may see, with its heading. */
  declared: readonly DisplayColumn[];
  stored: GridLayoutState | undefined;
  events: DisplayEventHandlers | undefined;
}>): GridLayoutControls => {
  const fallback = useMemo(
    (): GridLayoutState | undefined =>
      contract === undefined
        ? undefined
        : {
            // Before the page is read there is nothing to store; the authored layout shows.
            persisted: false,
            queryId: "",
            revision: null,
            layout: authoredGridLayout(contract),
            reset: false,
          },
    [contract],
  );
  const source = stored ?? fallback;
  const [local, setLocal] = useState<Local | undefined>(() =>
    source === undefined ? undefined : startFrom(source),
  );
  // A new page read carries the stored layout again; the local copy starts over from it.
  let current = local;
  if (source !== undefined && current?.base !== source) {
    current = startFrom(source);
    setLocal(current);
  }
  const layout = current?.layout ?? { columns: [] };
  const latest = useRef({ current, carried, contract, events });
  latest.current = { current, carried, contract, events };

  const carriedByKey = useMemo(
    () => new Map(carried.map((column) => [column.key.toLowerCase(), column])),
    [carried],
  );
  const labels = useMemo(
    () => new Map(declared.map((column) => [column.key.toLowerCase(), column.label])),
    [declared],
  );
  const shown = useMemo(
    () =>
      layout.columns.flatMap((entry): GridColumn[] => {
        if (!entry.visible) return [];
        const column = carriedByKey.get(entry.fieldId);
        return column === undefined ? [] : [column];
      }),
    [layout, carriedByKey],
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
  const order = useMemo(() => shown.map((column) => column.key), [shown]);
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
      setLocal((held) => {
        if (held === undefined) return held;
        const next = update(held.layout);
        if (next === undefined || (sameLayout(next, held.layout) && !commit)) return held;
        return {
          ...held,
          layout: next,
          ...(commit ? { commits: held.commits + 1, resetting: false } : {}),
        };
      }),
    [],
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
            if (!(column.key in next)) return { fieldId: entry.fieldId, visible: entry.visible };
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
      setLocal((held) =>
        held === undefined ? held : { ...held, commits: held.commits + 1, resetting: false },
      ),
    [],
  );
  const moveColumn = useCallback(
    (key: string, offset: number): number | undefined => {
      const from = order.indexOf(key);
      if (from < 0) return undefined;
      const to = Math.max(0, Math.min(order.length - 1, from + offset));
      if (from === to) return from + 1;
      const target = order[to]!.toLowerCase();
      const moved = key.toLowerCase();
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
    [change, order],
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
  const reset = useCallback(() => {
    if (contract === undefined) return;
    const authored = authoredGridLayout(contract);
    setLocal((held) =>
      held === undefined
        ? held
        : { ...held, layout: authored, commits: held.commits + 1, resetting: true },
    );
  }, [contract]);

  // Stores committed changes: one write at a time, the latest layout after the person pauses.
  const writer = useRef<{
    timer: ReturnType<typeof setTimeout> | undefined;
    busy: boolean;
    again: boolean;
  }>({
    timer: undefined,
    busy: false,
    again: false,
  });
  const store = useCallback(async (): Promise<void> => {
    const held = writer.current;
    if (held.busy) {
      held.again = true;
      return;
    }
    const {
      current: snapshot,
      carried: loaded,
      contract: declaredContract,
      events: handlers,
    } = latest.current;
    const onColumns = handlers?.columns_changed;
    if (
      snapshot === undefined ||
      !snapshot.base.persisted ||
      declaredContract === undefined ||
      onColumns === undefined
    )
      return;
    const loadedKeys = new Set(loaded.map((column) => column.key.toLowerCase()));
    const read = snapshot.layout.columns.some(
      (entry) => entry.visible && !loadedKeys.has(entry.fieldId),
    );
    held.busy = true;
    let result: GridLayoutCommitResult = { outcome: "unavailable" };
    try {
      const outcome = await onColumns({
        event: "columns_changed",
        layout: snapshot.resetting ? null : snapshot.layout,
        expectedRevision: snapshot.revision,
        queryId: snapshot.base.queryId,
        read,
      });
      if (typeof outcome === "object" && outcome !== null && "outcome" in outcome)
        result = outcome as GridLayoutCommitResult;
    } finally {
      held.busy = false;
    }
    if (result.outcome === "saved" || result.outcome === "reset") {
      const revision = result.outcome === "saved" ? result.revision : null;
      setLocal((latestLocal) =>
        latestLocal === undefined ? latestLocal : { ...latestLocal, revision },
      );
    } else if (result.outcome === "conflict") {
      // Another tab stored a newer layout first: show it, from its revision.
      const adopted = resolveGridLayout(
        declaredContract,
        result.stored ?? undefined,
        snapshot.base.queryId,
      ).layout;
      setLocal((latestLocal) =>
        latestLocal === undefined
          ? latestLocal
          : { ...latestLocal, layout: adopted, revision: result.stored?.revision ?? null },
      );
      held.again = false;
      if (adopted.columns.some((entry) => entry.visible && !loadedKeys.has(entry.fieldId)))
        void handlers?.refresh?.({ event: "refresh" });
    }
    if (held.again) {
      held.again = false;
      await store();
    }
  }, []);
  const commits = current?.commits ?? 0;
  useEffect(() => {
    if (commits === 0) return;
    const held = writer.current;
    if (held.timer !== undefined) clearTimeout(held.timer);
    held.timer = setTimeout(() => {
      held.timer = undefined;
      void store();
    }, COMMIT_DELAY_MS);
  }, [commits, store]);
  useEffect(
    () => () => {
      const held = writer.current;
      if (held.timer !== undefined) clearTimeout(held.timer);
    },
    [],
  );

  const authored = useMemo(
    () => (contract === undefined ? undefined : authoredGridLayout(contract)),
    [contract],
  );
  const arranged = authored !== undefined && !sameLayout(layout, authored);
  return {
    columns,
    state: { order, widths },
    shown,
    entries,
    density: layout.density ?? contract?.density ?? "comfortable",
    persisted: source?.persisted === true,
    setWidths,
    commit,
    moveColumn,
    setVisible,
    setDensity,
    reset,
    arranged,
  };
};
