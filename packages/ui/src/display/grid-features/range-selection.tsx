"use client";

import { lazy, Suspense, useEffect, useRef, useState, type ReactElement } from "react";
import type { GridFeatureInteractionProps, GridFeatureModule } from "./registry";
import { GRID_ROOT, isInteractiveGridTarget } from "../table-interaction";
import { rangeToTsv } from "./range-copy";
import { RangeStatusBar, type StatusBarRange } from "./range-status-bar";
import { GridToolbarSlot } from "./toolbar";

const Find = lazy(() => import("./find"));
type Point = Readonly<{ row: number; column: number }>;
type Range = Readonly<{ anchor: Point; end: Point }>;
type PointerSelection = {
  pointerId: number;
  start: Point;
  clientX: number;
  clientY: number;
  active: boolean;
  suppressClick: boolean;
};
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
  // The settled rectangle as the status bar reads it; the ref above stays the painting authority.
  const [settled, setSettled] = useState<StatusBarRange | undefined>(undefined);
  // Replacing rows or columns invalidates a rectangle; it never follows a different query/page.
  const page = context.lines;
  const columns = context.columns;
  useEffect(() => {
    const root = surface.rootRef.current;
    if (root === null || settings?.rangeSelect !== true) return;
    const previousMulti = root.getAttribute("aria-multiselectable");
    root.setAttribute("aria-multiselectable", "true");
    range.current = undefined;
    let pointer: PointerSelection | undefined;
    setAnnouncement("");
    setSettled(undefined);
    const publish = (): void => {
      const held = range.current;
      setSettled(
        held === undefined
          ? undefined
          : {
              firstRow: Math.min(held.anchor.row, held.end.row),
              lastRow: Math.max(held.anchor.row, held.end.row),
              firstColumn: Math.min(held.anchor.column, held.end.column),
              lastColumn: Math.max(held.anchor.column, held.end.column),
            },
      );
    };
    const columnIds = columns.map((column) => column.key);
    const pointOf = (target: EventTarget | null): Point | undefined => {
      if (!(target instanceof Element)) return;
      const cell = target.closest<HTMLElement>("[data-grid-cell]");
      if (cell === null || !root.contains(cell) || cell.closest(GRID_ROOT) !== root) return;
      const row = Number(cell.dataset.row);
      const column = columnIds.indexOf(cell.dataset.col ?? "");
      // A notice beneath a row spans every column: it holds no values to select.
      if (row < 0 || row >= page.length || column < 0 || page[row]?.kind !== "row") return;
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
      publish();
    };
    // Copy writes the canonical text of the range from the page the grid already holds: no read.
    const copy = (event: ClipboardEvent): void => {
      const held = range.current;
      if (held === undefined || event.clipboardData === null) return;
      if (
        !(event.target instanceof Element) ||
        event.target.closest(GRID_ROOT) !== root ||
        isInteractiveGridTarget(event.target, root)
      )
        return;
      const firstRow = Math.min(held.anchor.row, held.end.row);
      const lastRow = Math.max(held.anchor.row, held.end.row);
      const firstColumn = Math.min(held.anchor.column, held.end.column);
      const lastColumn = Math.max(held.anchor.column, held.end.column);
      const rows = page
        .slice(firstRow, lastRow + 1)
        .flatMap((line) => (line.kind === "row" ? [line.row] : []));
      event.clipboardData.setData(
        "text/plain",
        rangeToTsv(rows, columns.slice(firstColumn, lastColumn + 1)),
      );
      event.preventDefault();
      setAnnouncement(
        `Copied ${rows.length} ${rows.length === 1 ? "row" : "rows"} and ${lastColumn - firstColumn + 1} ${lastColumn === firstColumn ? "column" : "columns"}.`,
      );
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
        if (!(event.target instanceof Element) || event.target.closest(GRID_ROOT) !== root) return;
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
        publish();
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
        publish();
        setAnnouncement("");
      }
    };
    const pointerdown = (event: PointerEvent): void => {
      pointer = undefined;
      const point = pointOf(event.target);
      if (point === undefined || event.button !== 0 || event.pointerType === "touch") return;
      // Links, editors and action buttons retain their own pointer behaviour.
      if (isInteractiveGridTarget(event.target, root)) return;
      event.preventDefault();
      select(event.shiftKey ? (range.current?.anchor ?? point) : point, point);
      pointer = {
        pointerId: event.pointerId,
        start: point,
        clientX: event.clientX,
        clientY: event.clientY,
        active: true,
        suppressClick: event.shiftKey || event.ctrlKey || event.metaKey || event.altKey,
      };
      latest.current.surface.focusCell(point.row, columnIds[point.column]!);
      announce();
    };
    const trackPointer = (event: PointerEvent): void => {
      if (pointer === undefined) return;
      const point = pointOf(event.target);
      // Keep the drag decision even if the pointer leaves the grid or returns to its start.
      pointer.suppressClick ||=
        Math.hypot(event.clientX - pointer.clientX, event.clientY - pointer.clientY) > 4 ||
        (point !== undefined &&
          (point.row !== pointer.start.row || point.column !== pointer.start.column)) ||
        event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey;
    };
    const pointermove = (event: PointerEvent): void => {
      if (pointer?.active !== true || pointer.pointerId !== event.pointerId) return;
      trackPointer(event);
      if (range.current === undefined) return;
      const point = pointOf(event.target);
      if (
        point === undefined ||
        (point.row === range.current.end.row && point.column === range.current.end.column)
      )
        return;
      select(range.current.anchor, point);
      latest.current.surface.focusCell(point.row, columnIds[point.column]!);
    };
    const pointerup = (event: PointerEvent): void => {
      if (pointer?.active !== true || pointer.pointerId !== event.pointerId) return;
      trackPointer(event);
      pointer.active = false;
      announce();
    };
    const pointercancel = (event: PointerEvent): void => {
      if (pointer?.pointerId !== event.pointerId) return;
      pointer.active = false;
      pointer.suppressClick = true;
      announce();
    };
    const click = (event: MouseEvent): void => {
      const selection = pointer;
      pointer = undefined;
      if (selection === undefined || isInteractiveGridTarget(event.target, root)) return;
      const point = pointOf(event.target);
      // A plain click selects one cell and reaches the row flow. Range gestures consume their
      // click, even when a cross-cell drag makes the browser target the row instead of a cell.
      if (
        selection.active ||
        selection.suppressClick ||
        point?.row !== selection.start.row ||
        point?.column !== selection.start.column ||
        event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
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
    window.addEventListener("pointermove", pointermove);
    root.addEventListener("click", click, true);
    root.addEventListener("copy", copy);
    window.addEventListener("pointerup", pointerup);
    window.addEventListener("pointercancel", pointercancel);
    paint();
    return () => {
      observer.disconnect();
      if (previousMulti === null) root.removeAttribute("aria-multiselectable");
      else root.setAttribute("aria-multiselectable", previousMulti);
      root.removeEventListener("keydown", keydown, true);
      root.removeEventListener("pointerdown", pointerdown, true);
      window.removeEventListener("pointermove", pointermove);
      root.removeEventListener("click", click, true);
      root.removeEventListener("copy", copy);
      window.removeEventListener("pointerup", pointerup);
      window.removeEventListener("pointercancel", pointercancel);
      range.current = undefined;
      for (const cell of root.querySelectorAll<HTMLElement>("[data-grid-cell][aria-selected]")) {
        if (cell.closest(GRID_ROOT) !== root) continue;
        cell.removeAttribute("aria-selected");
        cell.classList.remove(...selectionClasses);
      }
    };
  }, [page, columns, settings?.rangeSelect, surface.rootRef]);

  return (
    <>
      {settled === undefined ? null : (
        <GridToolbarSlot area="supplement">
          {settings?.rangeSelect ? (
            <span
              className="max-w-40 truncate text-xs text-muted-foreground"
              title="Shift + arrows or drag to select a range on this page"
            >
              Range selected
            </span>
          ) : null}
          {settings?.statusBar !== undefined ? (
            <RangeStatusBar context={context} range={settled} />
          ) : null}
        </GridToolbarSlot>
      )}
      {settings?.find ? (
        <Suspense fallback={null}>
          <Find context={context} surface={surface} />
        </Suspense>
      ) : null}
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>
    </>
  );
}

export const gridFeature: GridFeatureModule = { GridInteraction: RangeSelection };
