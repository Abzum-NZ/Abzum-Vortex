"use client";

import { Puck } from "@puckeditor/core";
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../lib/utils";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/empty";
import { Spinner } from "../components/spinner";
import { Icon } from "../icons";
import { studioPuckStyle } from "./studio-puck-style";
import { useStudioCanvas } from "./studio-puck-provider";

/**
 * The outline's rows are Puck's own list items, named by their `data-puck-layer-tree-id`. The button
 * that selects a row is the one without a `title`, because Puck gives the collapse and row-action
 * buttons one. Re-check this after a Puck upgrade, as Studio does for the drawer rows.
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
 * Puck's outline plus what Puck lacks (design 6.5, M8): one labelled region that takes the Puck
 * colour map, arrow-key focus movement between its rows and Enter to select the focused row. Tab
 * reaches the region itself, the arrows walk its rows and the platform focus ring stays the only
 * focus indicator. A draft that takes no edits makes the region inert: the outline, the canvas and
 * the bar agree.
 */
export function StudioOutlineRegion({ children }: Readonly<{ children: ReactNode }>) {
  const canvas = useStudioCanvas();
  const region = useRef<HTMLDivElement>(null);
  const inert = canvas.input.disabled === true;

  const moveFocus = (rows: readonly HTMLElement[], index: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (row === undefined) return false;
    selectButton(row)?.focus();
    return true;
  };

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
    if (index < 0) {
      // The region itself has the focus: the arrows enter the rows at the near end.
      const entered =
        event.key === "ArrowDown" || event.key === "Home"
          ? moveFocus(rows, 0)
          : event.key === "ArrowUp" || event.key === "End"
            ? moveFocus(rows, rows.length - 1)
            : false;
      if (entered) event.preventDefault();
      return;
    }
    if (event.key === "ArrowDown" && moveFocus(rows, index + 1)) event.preventDefault();
    else if (event.key === "ArrowUp" && moveFocus(rows, index - 1)) event.preventDefault();
    else if (event.key === "Home" && moveFocus(rows, 0)) event.preventDefault();
    else if (event.key === "End" && moveFocus(rows, rows.length - 1)) event.preventDefault();
  };

  return (
    <div
      ref={region}
      role="region"
      aria-label="Outline of the canvas blocks"
      aria-disabled={inert ? true : undefined}
      inert={inert}
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={studioPuckStyle}
      // Puck's outline scrolls its rows inside its own wrapper and draws only the rows in view, so
      // the region has a height of its own: the panel's, less what is drawn below the outline.
      className={cn("flex min-h-0 flex-1 flex-col", inert && "opacity-60")}
    >
      {children}
    </div>
  );
}

/**
 * The Outline tab's body: Puck's outline of the blocks Puck holds, a loading state while the canvas
 * waits for its compile (Puck holds no data then), or the empty state when no page is open.
 */
export function StudioPuckOutline({ open }: Readonly<{ open: boolean }>) {
  const canvas = useStudioCanvas();
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
  if (canvas.model.shown === undefined)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Spinner />
          </EmptyMedia>
          <EmptyTitle>Waiting for the canvas</EmptyTitle>
          <EmptyDescription>The blocks appear after the latest changes compile.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  return <Puck.Outline />;
}
