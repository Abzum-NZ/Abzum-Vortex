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
  /** Keys of carried columns the person hid. */
  hidden: readonly string[];
  /** Width in pixels by column key. */
  widths: Readonly<Record<string, number>>;
}>;

export type GridLayoutControls = Readonly<{
  columns: readonly GridColumn[];
  state: GridLayoutState;
  /** The carried columns in display order, without hidden ones. */
  shown: readonly GridColumn[];
  setWidths: (update: SetStateAction<Readonly<Record<string, number>>>) => void;
  setHidden: (key: string, hidden: boolean) => void;
  /** Moves a shown column by an offset among the shown columns; returns its new 1-based position. */
  moveColumn: (key: string, offset: number) => number | undefined;
  reset: () => void;
  changed: boolean;
}>;

const authoredLayout = (columns: readonly GridColumn[]): GridLayoutState => ({
  order: columns.map((column) => column.key),
  hidden: [],
  widths: Object.fromEntries(columns.map((column) => [column.key, columnWidth(column.declared)])),
});

/**
 * The column order, visibility and widths of one table, starting from the authored layout of the
 * columns the page carries. It is presentation state only: arranging, hiding or resizing a
 * carried column reads nothing. A different set of carried columns starts from the authored
 * layout again. Hiding is offered only for carried columns, and one column always stays shown.
 */
export const useGridLayout = (columns: readonly GridColumn[]): GridLayoutControls => {
  const signature = columns.map((column) => `${column.key}:${column.width}`).join("\u0000");
  const [held, setHeld] = useState(() => ({ signature, state: authoredLayout(columns) }));
  const state = held.signature === signature ? held.state : authoredLayout(columns);
  const update = useCallback(
    (change: (current: GridLayoutState) => GridLayoutState) =>
      setHeld((current) => ({
        signature,
        state: change(current.signature === signature ? current.state : authoredLayout(columns)),
      })),
    // `signature` names exactly the columns this layout belongs to.
    [signature],
  );
  const setWidths = useCallback(
    (next: SetStateAction<Readonly<Record<string, number>>>) =>
      update((current) => ({
        ...current,
        widths: typeof next === "function" ? next(current.widths) : next,
      })),
    [update],
  );
  const setHidden = useCallback(
    (key: string, hidden: boolean) =>
      update((current) => {
        const without = current.hidden.filter((held) => held !== key);
        const next = hidden ? [...without, key] : without;
        return next.length >= current.order.length ? current : { ...current, hidden: next };
      }),
    [update],
  );
  const shown = useMemo(
    () =>
      state.order.flatMap((key) => {
        const column = columns.find((candidate) => candidate.key === key);
        return column === undefined || state.hidden.includes(key) ? [] : [column];
      }),
    [columns, state.order, state.hidden],
  );
  const moveColumn = useCallback(
    (key: string, offset: number): number | undefined => {
      const visible = state.order.filter((held) => !state.hidden.includes(held));
      const from = visible.indexOf(key);
      const to = Math.max(0, Math.min(visible.length - 1, from + offset));
      if (from < 0 || from === to) return from < 0 ? undefined : from + 1;
      const target = visible[to]!;
      update((current) => {
        const order = current.order.filter((held) => held !== key);
        const at = order.indexOf(target);
        order.splice(offset > 0 ? at + 1 : at, 0, key);
        return { ...current, order };
      });
      return to + 1;
    },
    [state.order, state.hidden, update],
  );
  const reset = useCallback(() => update(() => authoredLayout(columns)), [update, columns]);
  const authored = authoredLayout(columns);
  const changed =
    state.hidden.length > 0 ||
    state.order.some((key, index) => authored.order[index] !== key) ||
    Object.entries(state.widths).some(([key, width]) => authored.widths[key] !== width);
  return { columns, state, shown, setWidths, setHidden, moveColumn, reset, changed };
};
