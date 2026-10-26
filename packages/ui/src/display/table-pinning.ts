"use client";

import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";
import { GRID_COLUMN_MIN_WIDTH, GRID_CONTROL_COLUMN_WIDTH } from "./table-geometry";
import type { GridLayoutControls } from "./table-layout";

export const EXPAND_COLUMN = "vortex-expand";
export const SELECT_COLUMN = "vortex-select";
export const ACTIONS_COLUMN = "vortex-actions";

/** A width variable shared by the grid and its cumulative logical pin offsets. */
export const sizeVariable = (id: string): string =>
  `--grid-col-${id.replace(/[^A-Za-z0-9_-]/gu, "_")}`;
const pinVariable = (id: string): string => `${sizeVariable(id)}-pin`;

/** Slots retain their styles across resizing; only the grid's CSS variables change. */
export const pinStyle = (id: string, side: "start" | "end"): CSSProperties => ({
  position: `var(${pinVariable(id)}-position)` as CSSProperties["position"],
  ...(side === "start"
    ? { insetInlineStart: `var(${pinVariable(id)}-offset)` }
    : { insetInlineEnd: `var(${pinVariable(id)}-offset)` }),
  zIndex: `var(${pinVariable(id)}-layer)` as unknown as number,
  borderInlineStart: `var(${pinVariable(id)}-border-start, 0px solid transparent)`,
  borderInlineEnd: `var(${pinVariable(id)}-border-end, 0px solid transparent)`,
  boxShadow: `var(${pinVariable(id)}-shadow, none)`,
});

/**
 * One cell per column: CSS sticky moves it within the same row. At least half the viewport (and
 * two minimum-width columns when space permits) remains available for scrolling. Pins that do
 * not fit stay in their authored order as ordinary cells; their stored intent is unchanged.
 * ResizeObserver handles inspector/full-screen/viewport changes without a record read.
 */
export function useGridPinning(
  scroll: RefObject<HTMLDivElement | null>,
  layout: GridLayoutControls,
  enabled: boolean,
  selection: boolean,
  actions: number,
  /** Rows expand to their related records, so the expand column pins first at the start. */
  expansion: boolean,
): Readonly<{ variables: CSSProperties; scrollPadding: CSSProperties }> {
  const [viewport, setViewport] = useState(0);
  // Edge shadows follow horizontal scrolling without re-rendering the rows during wheel input.
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!enabled || element === null) return;
    let previous = "";
    const update = (): void => {
      const start = element.scrollLeft > 1;
      const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      const next = `${start}:${end}`;
      if (next === previous) return;
      previous = next;
      element.style.setProperty(
        "--grid-pin-start-shadow",
        start ? "4px 0 8px -4px color-mix(in oklab, var(--foreground) 25%, transparent)" : "none",
      );
      element.style.setProperty(
        "--grid-pin-end-shadow",
        end ? "-4px 0 8px -4px color-mix(in oklab, var(--foreground) 25%, transparent)" : "none",
      );
    };
    element.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", update);
      element.style.removeProperty("--grid-pin-start-shadow");
      element.style.removeProperty("--grid-pin-end-shadow");
    };
  }, [scroll, enabled, layout.state.order]);
  // A grid without pinning never observes its width, so a plain table never re-renders on resize.
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!enabled || element === null) return;
    const observer = new ResizeObserver(() => setViewport(element.clientWidth));
    setViewport(element.clientWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, [scroll, enabled]);

  const style: Record<string, string | number> = {};
  const utilityWidth =
    (Number(expansion) + Number(selection)) * GRID_CONTROL_COLUMN_WIDTH + actions;
  let budget = Math.max(
    0,
    viewport - Math.min(viewport, Math.max(viewport / 2, GRID_COLUMN_MIN_WIDTH * 2)) - utilityWidth,
  );
  const accepted = new Set<string>();
  // Allocate in display order on each side, never leaving a hole in a pinned edge.
  if (enabled) {
    for (const side of ["start", "end"] as const) {
      const keys = layout.state.order.filter((id) => layout.state.pins[id.toLowerCase()] === side);
      if (side === "end") keys.reverse();
      for (const id of keys) {
        const width = layout.state.widths[id]!;
        if (width > budget) break;
        accepted.add(id);
        budget -= width;
      }
    }
  }
  const utilityPins = enabled && viewport >= utilityWidth + GRID_COLUMN_MIN_WIDTH;
  const edgeWidth = { start: 0, end: 0 };
  for (const side of ["start", "end"] as const) {
    const ids =
      side === "start"
        ? [
            ...(expansion ? [EXPAND_COLUMN] : []),
            ...(selection ? [SELECT_COLUMN] : []),
            ...layout.state.order.filter((id) => layout.state.pins[id.toLowerCase()] === side),
          ]
        : [
            ...(actions ? [ACTIONS_COLUMN] : []),
            ...layout.state.order
              .filter((id) => layout.state.pins[id.toLowerCase()] === side)
              .reverse(),
          ];
    const offsets: string[] = [];
    let lastPinned: string | undefined;
    for (const id of ids) {
      const utility = id === EXPAND_COLUMN || id === SELECT_COLUMN || id === ACTIONS_COLUMN;
      const active = utility ? utilityPins : accepted.has(id);
      style[`${pinVariable(id)}-position`] = active ? "sticky" : "relative";
      style[`${pinVariable(id)}-layer`] = active ? 10 : "auto";
      style[`${pinVariable(id)}-offset`] = active
        ? offsets.length === 0
          ? "0px"
          : `calc(${offsets.join(" + ")})`
        : "auto";
      if (active) {
        lastPinned = id;
        offsets.push(
          utility
            ? `${id === ACTIONS_COLUMN ? actions : GRID_CONTROL_COLUMN_WIDTH}px`
            : `var(${sizeVariable(id)}) * 1px`,
        );
        edgeWidth[side] += utility
          ? id === ACTIONS_COLUMN
            ? actions
            : GRID_CONTROL_COLUMN_WIDTH
          : layout.state.widths[id]!;
      }
    }
    if (lastPinned !== undefined) {
      style[`${pinVariable(lastPinned)}-border-${side === "start" ? "end" : "start"}`] =
        "1px solid var(--border)";
      style[`${pinVariable(lastPinned)}-shadow`] = `var(--grid-pin-${side}-shadow, none)`;
    }
  }
  // The viewport's scroll padding keeps a focused cell clear of the pinned edges.
  return {
    variables: style as CSSProperties,
    scrollPadding: {
      scrollPaddingInlineStart: edgeWidth.start,
      scrollPaddingInlineEnd: edgeWidth.end,
    },
  };
}
