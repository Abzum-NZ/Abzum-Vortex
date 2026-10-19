"use client";

import { useCallback, type ReactElement, type ReactNode, type RefObject } from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import type { DisplayRow } from "./projected-data";

/**
 * The body of a page of more than one hundred rows: only the rows in view (plus an overscan of six)
 * are mounted, at the fixed row height of the authored density, inside the grid's own scroll area.
 * It is its own chunk, so a table that never shows such a page never loads TanStack Virtual.
 */
export default function VirtualRows({
  rows,
  rowHeight,
  activeRow,
  stickyHeader,
  scrollRef,
  drawRow,
}: Readonly<{
  rows: readonly DisplayRow[];
  rowHeight: number;
  /** The row holding the grid's tab stop, or -1 for the header. */
  activeRow: number;
  stickyHeader: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  drawRow: (row: DisplayRow, index: number, top: number) => ReactNode;
}>): ReactElement {
  // The active row is always mounted: it stays while the window scrolls away, so focus is never
  // dropped, and a keyboard move to a row outside the window mounts it in the same render.
  const rangeExtractor = useCallback(
    (range: Range): number[] => {
      const indexes = defaultRangeExtractor(range);
      if (activeRow < 0 || activeRow >= range.count || indexes.includes(activeRow)) return indexes;
      return [...indexes, activeRow].sort((left, right) => left - right);
    },
    [activeRow],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    getItemKey: (index) => rows[index]?.recordId ?? index,
    overscan: 6,
    // The header row sits above the first row inside the same scroll area and stays over it.
    scrollMargin: rowHeight,
    scrollPaddingStart: stickyHeader ? rowHeight : 0,
    rangeExtractor,
  });
  return (
    <div role="rowgroup" style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
      {virtualizer.getVirtualItems().map((item) => {
        const row = rows[item.index];
        return row === undefined ? null : drawRow(row, item.index, item.start - rowHeight);
      })}
    </div>
  );
}
