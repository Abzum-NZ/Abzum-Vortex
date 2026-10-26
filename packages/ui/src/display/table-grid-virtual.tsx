"use client";

import { useCallback, type ReactElement, type ReactNode, type RefObject } from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import type { RowLine } from "./sub-rows";

/**
 * The body of a page of more than one hundred rows: only the rows in view (plus an overscan of six)
 * are mounted, at the fixed row height of the authored density, inside the grid's own scroll area.
 * A row whose related records are open, or a notice beneath a row, differs in height: each mounted
 * row is measured as it changes, so the window stays right. It is its own chunk, so a table that never shows such a page never loads TanStack
 * Virtual.
 */
export default function VirtualRows({
  lines,
  rowHeight,
  activeRow,
  expandedRecordIds,
  stickyHeader,
  scrollRef,
  drawRow,
}: Readonly<{
  lines: readonly RowLine[];
  rowHeight: number;
  /** The row holding the grid's tab stop, or -1 for the header. */
  activeRow: number;
  expandedRecordIds: readonly string[] | undefined;
  stickyHeader: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  drawRow: (line: RowLine, index: number) => ReactNode;
}>): ReactElement {
  // Keep the active row and the at most three expanded rows mounted. Scrolling must neither
  // discard a panel's pages nor repeat its read when the row returns to the window.
  const rangeExtractor = useCallback(
    (range: Range): number[] => {
      const indexes = new Set(defaultRangeExtractor(range));
      if (activeRow >= 0 && activeRow < range.count) indexes.add(activeRow);
      for (const recordId of expandedRecordIds ?? []) {
        const index = lines.findIndex((line) => line.id === recordId);
        if (index >= 0) indexes.add(index);
      }
      return [...indexes].sort((left, right) => left - right);
    },
    [activeRow, expandedRecordIds, lines],
  );
  // Item-key identity is a measurement-cache dependency. Keep it stable while scrolling so
  // moving the visible window does not rebuild the positions of every row in the loaded page.
  const getItemKey = useCallback((index: number) => lines[index]?.id ?? index, [lines]);
  const estimateSize = useCallback(() => rowHeight, [rowHeight]);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    overscan: 6,
    // The header row sits above the first row inside the same scroll area and stays over it.
    scrollMargin: rowHeight,
    scrollPaddingStart: stickyHeader ? rowHeight : 0,
    rangeExtractor,
    // Scrolling writes the rows' positions straight to the page and renders again only when the
    // window of rows changes, not on every scroll event.
    directDomUpdates: true,
    useFlushSync: false,
  });
  return (
    <div
      role="rowgroup"
      ref={virtualizer.containerRef}
      // While the rows scroll under a still pointer, none of them takes the hover: a wheel turn
      // repaints no row and starts no transition.
      className={virtualizer.isScrolling ? "pointer-events-none" : undefined}
      style={{ position: "relative" }}
    >
      {virtualizer.getVirtualItems().map((item) => {
        const line = lines[item.index];
        return line === undefined ? null : (
          <div
            key={item.key}
            role="none"
            data-index={item.index}
            ref={virtualizer.measureElement}
            className="absolute top-0 left-0 w-full"
          >
            {drawRow(line, item.index)}
          </div>
        );
      })}
    </div>
  );
}
