"use client";

import { Puck } from "@puckeditor/core";
import {
  useCallback,
  useEffect,
  useRef,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "../lib/utils";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/empty";
import { Spinner } from "../components/spinner";
import { Icon } from "../icons";
import { studioPuckStyle } from "./studio-puck-style";
import { useStudioCanvas } from "./studio-puck-provider";

/**
 * The outline's rows are Puck's own list items (`data-puck-layer-tree-id`). A row's own parts are
 * its direct children, so each lookup stays inside the row and never reaches a nested row. Puck
 * hashes its class names but keeps the readable part, so the parts are found by that part.
 * Re-check these after a Puck upgrade, as Studio does for the drawer rows.
 */
const ROW = "[data-puck-layer-tree-id]";
const SELECT_BUTTON = ':scope > [class*="Layer-inner"] button[class*="Layer-clickable"]';
const CARET_BUTTON = ':scope > [class*="Layer-inner"] [class*="Layer-caret"] button';
/** What takes the focus inside a row: Puck's drag handle, the caret, the row's own button. */
const ROW_STOPS = `${ROW} button, ${ROW} [tabindex]`;

const hasPart = (row: HTMLElement, part: string): boolean => row.className.includes(part);

const selectButton = (row: HTMLElement): HTMLButtonElement | null =>
  row.querySelector<HTMLButtonElement>(SELECT_BUTTON);

const rowOf = (element: Element, root: HTMLElement): HTMLElement | null => {
  const row = element.closest<HTMLElement>(ROW);
  return row !== null && root.contains(row) ? row : null;
};

/**
 * Puck's outline plus what Puck lacks (design 6.5, M8): one labelled region that takes the Puck
 * colour map, one tab stop for all its rows, the arrow keys between and into them, and Enter to
 * select. Puck gives every row its drag handle, caret and button a tab stop of their own, so the
 * region keeps only one of them (the row last focused) in the tab order and the arrows move the
 * rest. A draft that takes no edits makes the region inert: the outline, the canvas and the bar agree.
 */
export function StudioOutlineRegion({ children }: Readonly<{ children: ReactNode }>) {
  const canvas = useStudioCanvas();
  const region = useRef<HTMLDivElement>(null);
  const stop = useRef<HTMLElement | null>(null);
  const inert = canvas.input.disabled === true;
  const areaEmpty = canvas.model.slot?.items.length === 0;

  /** Moves the region's one tab stop to `row`'s own button. */
  const moveStop = useCallback((row: HTMLElement | null) => {
    const next = row === null ? null : selectButton(row);
    if (next === null || next === stop.current) return;
    stop.current?.setAttribute("tabindex", "-1");
    next.setAttribute("tabindex", "0");
    stop.current = next;
  }, []);

  useEffect(() => {
    const root = region.current;
    if (root === null) return;
    const take = (scope: ParentNode) => {
      for (const element of scope.querySelectorAll<HTMLElement>(ROW_STOPS))
        if (element !== stop.current) element.setAttribute("tabindex", "-1");
    };
    const settle = () => {
      if (stop.current !== null && stop.current.isConnected) return;
      stop.current = null;
      moveStop(root.querySelector<HTMLElement>(ROW));
    };
    take(root);
    settle();
    // Rows Puck draws later (a row expanded, a page loaded) join the same one tab stop.
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        // Puck's drag and drop sets a row handle's tab stop again when it updates: it stays out.
        if (
          record.type === "attributes" &&
          record.target instanceof HTMLElement &&
          record.target !== stop.current &&
          record.target.matches(ROW_STOPS) &&
          record.target.getAttribute("tabindex") !== "-1"
        )
          record.target.setAttribute("tabindex", "-1");
        for (const added of record.addedNodes) {
          if (!(added instanceof HTMLElement)) continue;
          if (added.matches(ROW_STOPS) && added !== stop.current)
            added.setAttribute("tabindex", "-1");
          take(added);
        }
      }
      settle();
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["tabindex"],
    });
    return () => observer.disconnect();
  }, [moveStop]);

  // Tab lands on the selected block's row when its row is drawn.
  const selectedAlias = canvas.input.selectedPlacementAlias;
  const shown = canvas.model.shown;
  useEffect(() => {
    const root = region.current;
    if (root === null || selectedAlias === null) return;
    moveStop(
      root.querySelector<HTMLElement>(`[data-puck-layer-tree-id="${CSS.escape(selectedAlias)}"]`),
    );
  }, [moveStop, selectedAlias, shown]);

  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const root = region.current;
    if (root === null || !(event.target instanceof HTMLElement)) return;
    moveStop(rowOf(event.target, root));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const root = region.current;
    const target = event.target;
    if (root === null || !(target instanceof HTMLElement)) return;
    const own = rowOf(target, root);
    if (own === null) return;
    const focusRow = (row: HTMLElement | null | undefined) => {
      const button = row === null || row === undefined ? null : selectButton(row);
      if (button === null) return false;
      button.focus();
      return true;
    };
    const rows = () => [...root.querySelectorAll<HTMLElement>(ROW)];
    const step = (offset: number) => {
      const all = rows();
      const index = all.indexOf(own) + offset;
      return focusRow(all[Math.max(0, Math.min(all.length - 1, index))]);
    };
    const hasZone = hasPart(own, "Layer--containsZone");
    const expanded = hasPart(own, "Layer--isExpanded");
    const toggle = () => own.querySelector<HTMLButtonElement>(CARET_BUTTON)?.click();
    let handled = true;
    switch (event.key) {
      case "Enter": {
        const button = selectButton(own);
        // One activation: the click is made here, not a second time by the button's own Enter.
        if (button === null || document.activeElement !== button) return;
        button.click();
        break;
      }
      case "ArrowDown":
        step(1);
        break;
      case "ArrowUp":
        step(-1);
        break;
      case "Home":
      case "End": {
        // Puck draws only the rows in view: scroll to the end, then take the row drawn there.
        const scroller = root.closest<HTMLElement>("[data-studio-rail-body]");
        const first = event.key === "Home";
        if (scroller !== null) scroller.scrollTop = first ? 0 : scroller.scrollHeight;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => focusRow(first ? rows()[0] : rows().at(-1))),
        );
        break;
      }
      case "ArrowRight":
        // Opens a closed row; on an open row, steps into its first child.
        if (!hasZone) handled = false;
        else if (!expanded) toggle();
        else focusRow(own.querySelector<HTMLElement>(`${ROW}`));
        break;
      case "ArrowLeft":
        // Closes an open row; on a closed row, steps to the row that holds it.
        if (hasZone && expanded) toggle();
        else if (!focusRow(own.parentElement?.closest<HTMLElement>(ROW))) handled = false;
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  };

  return (
    <div
      ref={region}
      role="region"
      aria-label="Outline of the canvas blocks"
      aria-disabled={inert ? true : undefined}
      inert={inert}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      style={studioPuckStyle}
      className={cn(
        "flex min-h-0 flex-col",
        // Delete and Duplicate are the canvas bar's: keyboard reachable there, with shadcn
        // tooltips and the reason when a block's references refuse them. Puck's row copies are
        // hover-only buttons with browser tooltips, so they are not drawn a second time here.
        "[&_[class*=LayerActions]]:hidden!",
        // Puck scrolls its rows in its own wrapper and virtualises them against it, which with no height
        // of its own is as tall as all of them. The rail body is the scroller, so Puck virtualises
        // against that and a long page draws only the rows in view.
        "[&_[class*=OutlineWrapper-layers]]:overflow-visible!",
        // An empty content area says so once, below the outline, in place of Puck's bare "No items".
        areaEmpty && "[&_[class*=LayerTree-helperRoot]]:hidden!",
        inert && "opacity-60",
      )}
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
  return (
    <>
      <Puck.Outline />
      {canvas.model.slot?.items.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyDescription>
              This content area has no blocks. Add a block from Blocks, or choose another content
              area above the canvas.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </>
  );
}
