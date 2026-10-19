"use client";

import { useCallback, useMemo, useState, type SetStateAction } from "react";
import type { RecordsTableColumnContract } from "@vortex/platform/schema";
import { columnWidth } from "./table-geometry";

/** One column the page carries: its field, heading, declaration and authored starting width. */
export type GridColumn = Readonly<{
  key: string;
  label: string;
  declared: RecordsTableColumnContract;
  sortable: boolean;
  width: number;
}>;

/** A person's arrangement of the columns the page carries. */
export type GridLayoutState = Readonly<{
  /** Every carried column's key, in display order. */
  order: readonly string[];
  /** Width in pixels by carried column key. */
  widths: Readonly<Record<string, number>>;
}>;

export type GridLayoutControls = Readonly<{
  /** The columns the page was read with, in declared order. */
  columns: readonly GridColumn[];
  state: GridLayoutState;
  /** The carried columns in display order. */
  shown: readonly GridColumn[];
  setWidths: (update: SetStateAction<Readonly<Record<string, number>>>) => void;
  /** Moves a column by an offset among the shown columns; returns its new 1-based position. */
  moveColumn: (key: string, offset: number) => number | undefined;
  /** Returns the order and widths to the authored ones. */
  reset: () => void;
  /** Whether the order or a width differs from the authored layout. */
  arranged: boolean;
}>;

/** What the person changed: an order once they moved a column, and the widths they set. */
type Arrangement = Readonly<{
  order: readonly string[] | undefined;
  widths: Readonly<Record<string, number>>;
}>;

const AUTHORED: Arrangement = Object.freeze({ order: undefined, widths: Object.freeze({}) });

/**
 * The column order and widths of one table. Which columns the page carries is query state the
 * server reads with (a hidden column is never sent); this is presentation state only, so moving or
 * resizing a column reads nothing. The arrangement survives a read that shows or hides a column:
 * a column that joins keeps the person's order and goes last, and one that leaves is dropped.
 */
export const useGridLayout = (columns: readonly GridColumn[]): GridLayoutControls => {
  const [arrangement, setArrangement] = useState<Arrangement>(AUTHORED);
  const state = useMemo((): GridLayoutState => {
    const keys = columns.map((column) => column.key);
    const order =
      arrangement.order === undefined
        ? keys
        : [
            ...arrangement.order.filter((key) => keys.includes(key)),
            ...keys.filter((key) => !arrangement.order!.includes(key)),
          ];
    const widths = Object.fromEntries(
      columns.map((column) => [
        column.key,
        arrangement.widths[column.key] ?? columnWidth(column.declared),
      ]),
    );
    return { order, widths };
  }, [arrangement, columns]);
  const setWidths = useCallback(
    (next: SetStateAction<Readonly<Record<string, number>>>) =>
      setArrangement((current) => ({
        ...current,
        widths: { ...current.widths, ...(typeof next === "function" ? next(state.widths) : next) },
      })),
    [state.widths],
  );
  const shown = useMemo(
    () =>
      state.order.flatMap((key) => {
        const column = columns.find((candidate) => candidate.key === key);
        return column === undefined ? [] : [column];
      }),
    [columns, state.order],
  );
  const moveColumn = useCallback(
    (key: string, offset: number): number | undefined => {
      const from = state.order.indexOf(key);
      if (from < 0) return undefined;
      const to = Math.max(0, Math.min(state.order.length - 1, from + offset));
      if (from === to) return from + 1;
      const order = state.order.filter((held) => held !== key);
      order.splice(to, 0, key);
      setArrangement((current) => ({ ...current, order }));
      return to + 1;
    },
    [state.order],
  );
  const reset = useCallback(() => setArrangement(AUTHORED), []);
  const arranged =
    state.order.some((key, index) => columns[index]?.key !== key) ||
    columns.some((column) => state.widths[column.key] !== columnWidth(column.declared));
  return { columns, state, shown, setWidths, moveColumn, reset, arranged };
};
