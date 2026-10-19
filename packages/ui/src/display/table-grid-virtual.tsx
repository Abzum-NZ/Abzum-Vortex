"use client";

import { useCallback, type ReactElement, type ReactNode, type RefObject } from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import type { DisplayRow } from "./projected-data";

/**
 * The body of a page of more than one hundred rows: only the rows in view (plus an overscan of six)
 * are mounted, at the fixed row height of the authored density, inside the grid's own scroll area.
 * A row whose related records are open is taller: each mounted row is measured as it changes, so
 * the window stays right. It is its own chunk, so a table that never shows such a page never loads TanStack
 * Virtual.
 */
export default function VirtualRows({
  rows,
  rowHeight,
  activeRow,
  expandedRecordIds,
  stickyHeader,
  scrollRef,
  drawRow,
}: Readonly<{
  rows: readonly DisplayRow[];
  rowHeight: number;
  /** The row holding the grid's tab stop, or -1 for the header. */
  activeRow: number;
  expandedRecordIds: readonly string[] | undefined;
  stickyHeader: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  drawRow: (row: DisplayRow, index: number) => ReactNode;
}>): ReactElement {
  // Keep the active row and the at most three expanded rows mounted. Scrolling must neither
  // discard a panel's pages nor repeat its read when the row returns to the window.
  const rangeExtractor = useCallback(
    (range: Range): number[] => {
      const indexes = new Set(defaultRangeExtractor(range));
      if (activeRow >= 0 && activeRow < range.count) indexes.add(activeRow);
      for (const recordId of expandedRecordIds ?? []) {
        const index = rows.findIndex((row) => row.recordId === recordId);
        if (index >= 0) indexes.add(index);
      }
      return [...indexes].sort((left, right) => left - right);
    },
    [activeRow, expandedRecordIds, rows],
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
        return row === undefined ? null : (
          <div
            key={item.key}
            role="none"
            data-index={item.index}
            ref={virtualizer.measureElement}
            className="absolute top-0 left-0 w-full"
            style={{ transform: `translateY(${item.start - rowHeight}px)` }}
          >
            {drawRow(row, item.index)}
          </div>
        );
      })}
    </div>
  );
}
