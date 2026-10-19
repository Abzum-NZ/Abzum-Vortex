"use client";

import type { ReactElement } from "react";
import {
  RECORDS_TABLE_COLUMN_MAXIMUM_WIDTH,
  RECORDS_TABLE_COLUMN_MINIMUM_WIDTH,
} from "@vortex/platform/schema";
import { DropdownMenuItem } from "../../components/dropdown-menu";
import type { GridColumn } from "../table-layout";

const pixels = (value: string): number => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * The width that fits a column's mounted heading and cells: each cell's content at its natural
 * width plus the cell's own padding and gaps. Only what is on screen is measured (the heading and
 * the rows of the current page the grid mounted); nothing is read. The result stays within the
 * contract's bounds.
 */
const fittingWidth = (grid: HTMLElement, columnId: string): number | undefined => {
  const cells = grid.querySelectorAll<HTMLElement>(
    `[data-grid-cell][data-col="${CSS.escape(columnId)}"]`,
  );
  if (cells.length === 0) return undefined;
  let widest = 0;
  for (const cell of cells) {
    const style = getComputedStyle(cell);
    // In-flow content only: a resize handle is positioned over the edge and screen-reader text
    // takes no room.
    const children = [...cell.children].filter(
      (child) =>
        getComputedStyle(child).position !== "absolute" && !child.classList.contains("sr-only"),
    );
    const gap = pixels(style.columnGap) * Math.max(0, children.length - 1);
    // A truncated text reports its full width as its scroll width; an icon reports its own box.
    const content = children.reduce(
      (sum, child) =>
        sum +
        (child instanceof HTMLElement ? child.scrollWidth : child.getBoundingClientRect().width),
      0,
    );
    widest = Math.max(
      widest,
      Math.ceil(content + gap + pixels(style.paddingLeft) + pixels(style.paddingRight)),
    );
  }
  return Math.max(
    RECORDS_TABLE_COLUMN_MINIMUM_WIDTH,
    Math.min(RECORDS_TABLE_COLUMN_MAXIMUM_WIDTH, widest),
  );
};

/**
 * The column menu's Auto-size item, loaded only when the menu of a column that allows auto-size
 * opens. It measures the mounted cells and hands the width to the layout, which stores it with one
 * coalesced write.
 */
export default function AutoSizeItem({
  column,
  grid,
  onSize,
}: Readonly<{
  column: GridColumn;
  /** The grid element whose mounted cells are measured. */
  grid: () => HTMLElement | null;
  onSize: (width: number) => void;
}>): ReactElement {
  return (
    <DropdownMenuItem
      onClick={() => {
        const element = grid();
        const width = element === null ? undefined : fittingWidth(element, column.key);
        if (width !== undefined) onSize(width);
      }}
    >
      Auto-size column
    </DropdownMenuItem>
  );
}
