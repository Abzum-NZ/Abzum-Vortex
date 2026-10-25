"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";
import { Button } from "../../components/button";
import { Input } from "../../components/input";
import { Icon } from "../../icons/icon";
import { cellValueToText } from "../cell";
import { useDateFormatOptions } from "../date-format-context";
import { GRID_ROOT } from "../table-interaction";
import type { GridFeatureInteractionProps } from "./registry";

type Match = Readonly<{ row: number; field: string }>;
const matchClasses = [
  "underline",
  "decoration-primary",
  "decoration-2",
  "[&_*]:underline",
  "[&_*]:decoration-primary",
  "[&_*]:decoration-2",
];
const currentClasses = ["outline-solid!", "outline-2", "outline-primary", "-outline-offset-2"];

/** Page-local find scans only projected, visible cells. Search all records uses the server event. */
export default function Find({ context, surface }: GridFeatureInteractionProps): ReactElement {
  const dateFormat = useDateFormatOptions();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const previous = useRef<Match | undefined>(undefined);
  const latest = useRef(surface);
  latest.current = surface;
  const label = useId();
  const matches = useMemo<readonly Match[]>(() => {
    const term = query.toLocaleLowerCase();
    if (!open || term.length === 0) return [];
    return context.lines.flatMap((line, index) =>
      context.columns.flatMap((column) => {
        if (line.kind !== "row") return [];
        const cell = line.row.cells[column.key];
        if (cell === undefined || ["restricted", "unavailable", "empty"].includes(cell.kind))
          return [];
        return cellValueToText(cell, dateFormat).toLocaleLowerCase().includes(term)
          ? [{ row: index, field: column.key }]
          : [];
      }),
    );
  }, [context.lines, context.columns, query, open, dateFormat]);
  const current = matches.length === 0 ? undefined : matches[index % matches.length];
  useEffect(() => {
    if (current !== undefined) latest.current.focusCell(current.row, current.field, false);
  }, [current]);
  useEffect(() => {
    const root = surface.rootRef.current;
    if (root === null) return;
    const keydown = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.key.toLowerCase() !== "f"
      )
        return;
      if (!(event.target instanceof Element) || event.target.closest(GRID_ROOT) !== root) return;
      event.preventDefault();
      event.stopPropagation();
      const cell = event.target.closest<HTMLElement>("[data-grid-cell]");
      if (cell !== null)
        previous.current = { row: Number(cell.dataset.row), field: cell.dataset.col ?? "" };
      setOpen(true);
      input.current?.focus();
      input.current?.select();
    };
    root.addEventListener("keydown", keydown, true);
    return () => root.removeEventListener("keydown", keydown, true);
  }, [surface.rootRef]);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  useEffect(() => {
    const root = surface.rootRef.current;
    if (root === null) return;
    const keys = new Set(matches.map((match) => `${match.row}:${match.field}`));
    const paint = (): void => {
      for (const cell of root.querySelectorAll<HTMLElement>("[data-grid-cell]")) {
        if (cell.closest(GRID_ROOT) !== root) continue;
        const matching = keys.has(`${cell.dataset.row}:${cell.dataset.col}`);
        const active =
          current !== undefined &&
          cell.dataset.row === String(current.row) &&
          cell.dataset.col === current.field;
        for (const name of matchClasses) cell.classList.toggle(name, matching);
        for (const name of currentClasses) cell.classList.toggle(name, active);
      }
    };
    const observer = new MutationObserver(paint);
    observer.observe(root, { childList: true, subtree: true });
    paint();
    return () => {
      observer.disconnect();
      for (const cell of root.querySelectorAll<HTMLElement>("[data-grid-cell]"))
        if (cell.closest(GRID_ROOT) === root)
          cell.classList.remove(...matchClasses, ...currentClasses);
    };
  }, [matches, current, surface.rootRef]);
  const close = (): void => {
    setOpen(false);
    const destination =
      previous.current ??
      current ??
      (context.rows.length > 0 && context.columns[0] !== undefined
        ? { row: 0, field: context.columns[0].key }
        : undefined);
    previous.current = undefined;
    if (destination !== undefined) latest.current.focusCell(destination.row, destination.field);
  };
  const step = (offset: number): void => {
    if (matches.length === 0) return;
    const next = (index + offset + matches.length) % matches.length;
    setIndex(next);
  };
  if (!open)
    return (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          // Only Ctrl+F from a cell has a cell to return to.
          previous.current = undefined;
          setOpen(true);
        }}
      >
        <Icon name="search" aria-hidden="true" />
        Find on page
      </Button>
    );
  return (
    <div
      role="search"
      aria-label={`Find on page in ${context.accessibleName}`}
      className="flex flex-wrap items-center gap-1"
    >
      <Input
        ref={input}
        aria-label="Find on this page"
        aria-describedby={label}
        value={query}
        maxLength={200}
        className="w-48"
        onChange={(event) => {
          setQuery(event.currentTarget.value);
          setIndex(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
          if (event.key === "Enter") {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          }
        }}
      />
      <span
        id={label}
        role="status"
        aria-live="polite"
        className="text-xs text-muted-foreground tabular-nums"
      >
        {query === ""
          ? "Enter text"
          : matches.length === 0
            ? "No matches on this page"
            : `${(index % matches.length) + 1} of ${matches.length} matching cells`}
      </span>
      <Button
        size="icon-sm"
        variant="ghost"
        title="Previous match"
        aria-label="Previous match"
        disabled={matches.length === 0}
        onClick={() => step(-1)}
      >
        <Icon name="chevron-up" aria-hidden="true" />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        title="Next match"
        aria-label="Next match"
        disabled={matches.length === 0}
        onClick={() => step(1)}
      >
        <Icon name="chevron-down" aria-hidden="true" />
      </Button>
      {context.features.search !== true || context.events?.search_changed === undefined ? null : (
        <Button
          size="sm"
          variant="ghost"
          disabled={query.trim() === ""}
          onClick={() => {
            void context.events?.search_changed?.({ event: "search_changed", query });
          }}
        >
          Search all records
        </Button>
      )}
      <Button
        size="icon-sm"
        variant="ghost"
        title="Close find"
        aria-label="Close find"
        onClick={close}
      >
        <Icon name="close" aria-hidden="true" />
      </Button>
    </div>
  );
}
