"use client";

import { Puck } from "@puckeditor/core";
import { useCallback, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/empty";
import { Icon } from "../icons";

/**
 * The outline's rows are Puck's own list items (`data-puck-layer-tree-id`); the button that selects
 * a row is the one without a `title`, because Puck gives the collapse and row-action buttons one.
 * Re-check this after a Puck upgrade, as Studio does for the drawer rows.
 */
const ROW = "[data-puck-layer-tree-id]";

const selectButton = (row: HTMLElement): HTMLButtonElement | undefined =>
  [...row.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => !button.hasAttribute("title"),
  );

/** The rows of the outline that can take the focus, in the order they are drawn. */
const focusableRows = (root: HTMLElement): readonly HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(ROW)].filter((row) => selectButton(row) !== undefined);

/**
 * Puck's outline plus what Puck lacks (design 6.5, M8): one labelled region, arrow-key focus
 * movement between its rows and Enter to select the focused row. Tab reaches the region itself,
 * the arrows walk its rows and the platform focus ring stays the only focus indicator.
 */
export function StudioOutlineRegion({ children }: Readonly<{ children: ReactNode }>) {
  const region = useRef<HTMLDivElement>(null);

  const moveFocus = useCallback((rows: readonly HTMLElement[], index: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (row === undefined) return false;
    selectButton(row)?.focus();
    return true;
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const root = region.current;
    const target = event.target;
    if (root === null || !(target instanceof HTMLElement)) return;
    const rows = focusableRows(root);
    if (rows.length === 0) return;
    const own = target.closest<HTMLElement>(ROW);
    const index = own === null || !root.contains(own) ? -1 : rows.indexOf(own);
    if (event.key === "Enter" && own !== null && index >= 0) {
      const button = selectButton(own);
      // One activation: the click is made here, not a second time by the button's own Enter.
      if (button !== undefined && document.activeElement === button) {
        event.preventDefault();
        button.click();
      }
      return;
    }
    const first = index < 0 ? 0 : index;
    if (event.key === "ArrowDown" && moveFocus(rows, first + 1)) event.preventDefault();
    else if (event.key === "ArrowUp" && moveFocus(rows, first - 1)) event.preventDefault();
    else if (event.key === "Home" && moveFocus(rows, 0)) event.preventDefault();
    else if (event.key === "End" && moveFocus(rows, rows.length - 1)) event.preventDefault();
  };

  return (
    <div
      ref={region}
      role="region"
      aria-label="Outline of the canvas blocks"
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="flex min-h-0 flex-col"
    >
      {children}
    </div>
  );
}

/** The Outline tab's body: Puck's outline of the blocks Puck holds, or the empty state when no page is open. */
export function StudioPuckOutline({
  open,
  areaEmpty,
}: Readonly<{ open: boolean; areaEmpty: boolean }>) {
  if (!open)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon name="list-tree" />
          </EmptyMedia>
          <EmptyTitle>No page open</EmptyTitle>
          <EmptyDescription>
            Choose a page or layout in Structure to see its blocks.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  return (
    <>
      <Puck.Outline />
      {areaEmpty && (
        <p className="px-4 pb-3 text-sm text-muted-foreground">
          This content area has no blocks. Add a block from Blocks, or choose another content area
          above the canvas.
        </p>
      )}
    </>
  );
}
