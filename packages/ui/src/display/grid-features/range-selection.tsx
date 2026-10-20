"use client";

import { lazy, Suspense, useEffect, useRef, useState, type ReactElement } from "react";
import type { GridFeatureInteractionProps, GridFeatureModule } from "./registry";

const Find = lazy(() => import("./find"));
type Point = Readonly<{ row: number; column: number }>;
type Range = Readonly<{ anchor: Point; end: Point }>;
const selectionClasses = [
  "bg-accent",
  "text-accent-foreground",
  "inset-ring-1",
  "inset-ring-primary",
];

/** One local rectangle, independent of bulk record selection and bounded by the loaded page. */
function RangeSelection({ context, surface }: GridFeatureInteractionProps): ReactElement {
  const settings = context.features.spreadsheet;
  const [announcement, setAnnouncement] = useState("");
  const latest = useRef({ context, surface });
  latest.current = { context, surface };
  const range = useRef<Range | undefined>(undefined);
  const dragging = useRef(false);
  // Replacing rows or columns invalidates a rectangle; it never follows a different query/page.
  const page = context.rows;
  const columns = context.columns;
  useEffect(() => {
    const root = surface.rootRef.current;
    if (root === null || settings?.rangeSelect !== true) return;
    const previousMulti = root.getAttribute("aria-multiselectable");
    root.setAttribute("aria-multiselectable", "true");
    range.current = undefined;
    dragging.current = false;
    setAnnouncement("");
    const columnIds = columns.map((column) => column.key);
    const pointOf = (target: EventTarget | null): Point | undefined => {
      if (!(target instanceof Element)) return;
      const cell = target.closest<HTMLElement>("[data-grid-cell]");
      if (cell === null || !root.contains(cell) || cell.closest("[role='grid']") !== root) return;
      const row = Number(cell.dataset.row);
      const column = columnIds.indexOf(cell.dataset.col ?? "");
      if (row < 0 || row >= page.length || column < 0) return;
      return { row, column };
    };
    const paint = (): void => {
      const held = range.current;
      for (const cell of root.querySelectorAll<HTMLElement>("[data-grid-cell]")) {
        const point = pointOf(cell);
        if (point === undefined) continue;
        const selected =
          held !== undefined &&
          point.row >= Math.min(held.anchor.row, held.end.row) &&
          point.row <= Math.max(held.anchor.row, held.end.row) &&
          point.column >= Math.min(held.anchor.column, held.end.column) &&
          point.column <= Math.max(held.anchor.column, held.end.column);
        cell.setAttribute("aria-selected", String(selected));
        for (const name of selectionClasses) cell.classList.toggle(name, selected);
      }
    };
    const announce = (): void => {
      const held = range.current;
      setAnnouncement(
        held === undefined
          ? "Selection cleared"
          : `Selected rows ${Math.min(held.anchor.row, held.end.row) + 1} to ${Math.max(held.anchor.row, held.end.row) + 1}, columns ${columns[Math.min(held.anchor.column, held.end.column)]!.label} to ${columns[Math.max(held.anchor.column, held.end.column)]!.label}. This page only.`,
      );
    };
    const select = (anchor: Point, end: Point): void => {
      range.current = { anchor, end };
      paint();
    };
    const keydown = (event: KeyboardEvent): void => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-grid-cell]") !== event.target
      )
        return;
      if (event.altKey || event.isComposing) return;
      const control = event.ctrlKey || event.metaKey;
      if (control && event.key.toLowerCase() === "a" && page.length > 0 && columns.length > 0) {
        if (!(event.target instanceof Element) || event.target.closest("[role='grid']") !== root)
          return;
        event.preventDefault();
        event.stopPropagation();
        select({ row: 0, column: 0 }, { row: page.length - 1, column: columns.length - 1 });
        announce();
        return;
      }
      const point = pointOf(event.target);
      if (point === undefined) return;
      if (event.key === "Escape") {
        range.current = undefined;
        paint();
        announce();
        return;
      }
      if (
        event.shiftKey &&
        !control &&
        ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)
      ) {
        event.preventDefault();
        event.stopPropagation();
        const end = {
          row: Math.max(
            0,
            Math.min(
              page.length - 1,
              point.row + (event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0),
            ),
          ),
          column: Math.max(
            0,
            Math.min(
              columns.length - 1,
              point.column + (event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0),
            ),
          ),
        };
        select(range.current?.anchor ?? point, end);
        latest.current.surface.focusCell(end.row, columnIds[end.column]!);
        announce();
      } else if (
        !event.shiftKey &&
        !control &&
        [
          "ArrowDown",
          "ArrowUp",
          "ArrowLeft",
          "ArrowRight",
          "Home",
          "End",
          "PageUp",
          "PageDown",
        ].includes(event.key)
      ) {
        range.current = undefined;
        paint();
        setAnnouncement("");
      }
    };
    const pointerdown = (event: PointerEvent): void => {
      const point = pointOf(event.target);
      if (point === undefined || event.button !== 0 || event.pointerType === "touch") return;
      // Links, editors and action buttons retain their own pointer behaviour.
      if (
        event.target instanceof Element &&
        event.target.closest("a,button,input,select,textarea,[contenteditable='true']")
      )
        return;
      event.preventDefault();
      select(event.shiftKey ? (range.current?.anchor ?? point) : point, point);
      dragging.current = true;
      latest.current.surface.focusCell(point.row, columnIds[point.column]!);
      announce();
    };
    const pointermove = (event: PointerEvent): void => {
      if (!dragging.current || range.current === undefined) return;
      const point = pointOf(event.target);
      if (
        point === undefined ||
        (point.row === range.current.end.row && point.column === range.current.end.column)
      )
        return;
      select(range.current.anchor, point);
      latest.current.surface.focusCell(point.row, columnIds[point.column]!);
    };
    const pointerup = (): void => {
      if (!dragging.current) return;
      dragging.current = false;
      announce();
    };
    const click = (event: MouseEvent): void => {
      // Selecting a range never invokes a row-click flow, including the click after a drag.
      if (
        range.current !== undefined &&
        pointOf(event.target) !== undefined &&
        event.target instanceof Element &&
        !event.target.closest("a,button,input,select,textarea,[contenteditable='true']")
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    // Painting just mounted cells keeps a 200-row virtual page bounded; changing a rectangle
    // neither renders every row nor asks the server to read records.
    const observer = new MutationObserver(paint);
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-row", "data-col"],
    });
    root.addEventListener("keydown", keydown, true);
    root.addEventListener("pointerdown", pointerdown, true);
    root.addEventListener("pointermove", pointermove);
    root.addEventListener("click", click, true);
    window.addEventListener("pointerup", pointerup);
    window.addEventListener("pointercancel", pointerup);
    paint();
    return () => {
      observer.disconnect();
      if (previousMulti === null) root.removeAttribute("aria-multiselectable");
      else root.setAttribute("aria-multiselectable", previousMulti);
      root.removeEventListener("keydown", keydown, true);
      root.removeEventListener("pointerdown", pointerdown, true);
      root.removeEventListener("pointermove", pointermove);
      root.removeEventListener("click", click, true);
      window.removeEventListener("pointerup", pointerup);
      window.removeEventListener("pointercancel", pointerup);
      range.current = undefined;
      for (const cell of root.querySelectorAll<HTMLElement>("[data-grid-cell][aria-selected]")) {
        if (cell.closest("[role='grid']") !== root) continue;
        cell.removeAttribute("aria-selected");
        cell.classList.remove(...selectionClasses);
      }
    };
  }, [page, columns, settings?.rangeSelect, surface.rootRef]);

  return (
    <div className="sticky left-0 flex flex-wrap items-center gap-2 px-2 py-1">
      {settings?.rangeSelect ? (
        <span className="text-xs text-muted-foreground">
          Shift + arrows or drag to select a range on this page
        </span>
      ) : null}
      {settings?.find ? (
        <Suspense fallback={null}>
          <Find context={context} surface={surface} />
        </Suspense>
      ) : null}
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>
    </div>
  );
}

export const gridFeature: GridFeatureModule = { GridInteraction: RangeSelection };
