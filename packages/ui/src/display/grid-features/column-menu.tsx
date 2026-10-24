"use client";

import { lazy, Suspense, type ReactElement, type ReactNode } from "react";
import {
  RECORDS_TABLE_MAXIMUM_SORT_KEYS,
  type RecordsTableSortKey,
  type RecordsTableSortState,
} from "@vortex/platform/schema";
import { Button } from "../../components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../../components/dropdown-menu";
import { Icon } from "../../icons/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/tooltip";
import type { GridColumn } from "../table-layout";

/** Auto-size is its own chunk: it loads only when the menu of a column that allows it opens. */
const AutoSizeItem = lazy(() => import("./auto-size"));

const sameFieldKey = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

export type ColumnMenuProps = Readonly<{
  column: GridColumn;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where focus returns when the menu closes: the column's heading cell. */
  returnFocus: () => HTMLElement | null;
  /** The sort the shown page was read in; undefined when the column cannot be sorted. */
  sort: RecordsTableSortState | undefined;
  sortable: boolean;
  onSort: (keys: readonly RecordsTableSortKey[]) => void;
  /** The column's 1-based position among the shown columns, and how many are shown. */
  position: number;
  shownCount: number;
  onHide: () => void;
  onMove: (offset: number) => void;
  /** The grid whose mounted cells auto-size measures. */
  grid: () => HTMLElement | null;
  onAutoSize: (width: number) => void;
  /** Widens (1) or narrows (-1) the column by one step, as Alt+Right or Alt+Left on its heading do. */
  onResize: (direction: 1 | -1) => void;
  /** The items the projected grid features add for this column (filter, group, pin...). */
  featureItems: ReactNode;
}>;

/**
 * The one menu of a column heading. Its core items (sort, hide, move) are always offered when the
 * column supports them; auto-size shows when the column allows it, and every optional grid feature
 * adds its own items through the registry, only when the viewer's projection turns it on. Sorting
 * reports the declared `sort_changed` event and the server re-checks that each key is sortable;
 * hide, move and auto-size change only the person's layout and read nothing.
 */
export function ColumnMenu({
  column,
  open,
  onOpenChange,
  returnFocus,
  sort,
  sortable,
  onSort,
  position,
  shownCount,
  onHide,
  onMove,
  grid,
  onAutoSize,
  onResize,
  featureItems,
}: ColumnMenuProps): ReactElement {
  const keys = sort?.keys ?? [];
  const index = keys.findIndex((key) => sameFieldKey(key.fieldId, column.key));
  const held = index < 0 ? undefined : keys[index];
  const only = (direction: RecordsTableSortKey["direction"]): void =>
    onSort([{ fieldId: column.key, direction }]);
  return (
    <DropdownMenu open={open} onOpenChange={(next: boolean) => onOpenChange(next)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`${column.label} column menu`}
                  className="ms-auto shrink-0"
                  // Opening the menu is not a request to sort by the column.
                  onClick={(event) => event.stopPropagation()}
                />
              }
            />
          }
        >
          <Icon name="chevron-down" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>{column.label} column menu</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        className="min-w-48"
        finalFocus={() => returnFocus() ?? true}
        // The menu is portalled, but React still bubbles its clicks through the heading.
        onClick={(event) => event.stopPropagation()}
      >
        {!sortable ? null : (
          <>
            <DropdownMenuGroup>
              <DropdownMenuItem
                disabled={keys.length === 1 && held?.direction === "ascending"}
                onClick={() => only("ascending")}
              >
                <Icon name="arrow-up" aria-hidden="true" />
                Sort ascending
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={keys.length === 1 && held?.direction === "descending"}
                onClick={() => only("descending")}
              >
                <Icon name="arrow-down" aria-hidden="true" />
                Sort descending
              </DropdownMenuItem>
              {held !== undefined || keys.length === 0 ? null : (
                <DropdownMenuItem
                  disabled={keys.length >= RECORDS_TABLE_MAXIMUM_SORT_KEYS}
                  onClick={() => onSort([...keys, { fieldId: column.key, direction: "ascending" }])}
                >
                  <Icon name="plus" aria-hidden="true" />
                  Add to sort
                </DropdownMenuItem>
              )}
              {held === undefined || sort?.explicit !== true ? null : (
                <DropdownMenuItem onClick={() => onSort(keys.filter((_, at) => at !== index))}>
                  <Icon name="close" aria-hidden="true" />
                  Clear sort
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        )}
        {featureItems}
        <DropdownMenuGroup>
          {!column.declared.autoSize ? null : (
            <Suspense fallback={null}>
              <AutoSizeItem column={column} grid={grid} onSize={onAutoSize} />
            </Suspense>
          )}
          {/* The pointer drags the heading's edge; these are the same widths without a pointer. */}
          <DropdownMenuItem closeOnClick={false} onClick={() => onResize(1)}>
            <Icon name="plus" aria-hidden="true" />
            Widen column
            <DropdownMenuShortcut>Alt+Right</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem closeOnClick={false} onClick={() => onResize(-1)}>
            <Icon name="minus" aria-hidden="true" />
            Narrow column
            <DropdownMenuShortcut>Alt+Left</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={position <= 1} onClick={() => onMove(-1)}>
            <Icon name="chevron-left" aria-hidden="true" />
            Move left
          </DropdownMenuItem>
          <DropdownMenuItem disabled={position >= shownCount} onClick={() => onMove(1)}>
            <Icon name="chevron-right" aria-hidden="true" />
            Move right
          </DropdownMenuItem>
          <DropdownMenuItem disabled={shownCount <= 1} onClick={onHide}>
            <Icon name="eye-off" aria-hidden="true" />
            Hide column
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
