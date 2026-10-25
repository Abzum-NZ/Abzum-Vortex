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
 * The width an element's in-flow content needs: its children at their natural widths plus its own
 * padding and gaps. In-flow content only: a resize handle or data bar is positioned over the cell
 * and screen-reader text takes no room.
 */
const contentWidth = (element: Element, style: CSSStyleDeclaration): number => {
  const children = [...element.children].filter(
    (child) =>
      getComputedStyle(child).position !== "absolute" && !child.classList.contains("sr-only"),
  );
  const gap = pixels(style.columnGap) * Math.max(0, children.length - 1);
  return (
    children.reduce((sum, child) => sum + naturalWidth(child), 0) +
    gap +
    pixels(style.paddingLeft) +
    pixels(style.paddingRight)
  );
};

/**
 * A child's natural width. A truncated text reports its full width as its scroll width and an icon
 * reports its own box. A growing wrapper (the conditional-format span) is as wide as the cell, so
 * its own content is measured instead, with its margins (it bleeds into the cell padding). Other
 * margins are not counted: an auto margin resolves to the free space the column has now.
 */
const naturalWidth = (element: Element): number => {
  if (!(element instanceof HTMLElement)) return element.getBoundingClientRect().width;
  const style = getComputedStyle(element);
  if (pixels(style.flexGrow) === 0 || element.children.length === 0) return element.scrollWidth;
  return contentWidth(element, style) + pixels(style.marginLeft) + pixels(style.marginRight);
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
  for (const cell of cells)
    widest = Math.max(widest, Math.ceil(contentWidth(cell, getComputedStyle(cell))));
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
