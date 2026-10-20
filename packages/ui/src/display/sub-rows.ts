"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { DisplayRow } from "./projected-data";

/**
 * A message or control a feature draws as a full-width row of the grid (or a list item of the
 * cards) beneath a parent row: a read in progress, a refusal, a failure, or "Show more".
 */
export type SubRowNotice = Readonly<{
  kind: "notice";
  id: string;
  tone: "info" | "alert";
  /** Reading is in progress; the message is announced and no control is offered. */
  busy?: boolean;
  message?: string;
  action?: Readonly<{ label: string; disabled?: boolean; run: () => void }>;
}>;

/** One entry beneath a parent row: a record of the table, or a notice about the level. */
export type SubRowEntry = Readonly<{ kind: "row"; row: DisplayRow }> | SubRowNotice;

/**
 * What a feature that contributes sub-rows holds for every open parent row: its entries in order,
 * and whether they are all of its records (so the set size of the level is known).
 */
export type SubRowsBeneath = ReadonlyMap<
  string,
  Readonly<{ entries: readonly SubRowEntry[]; complete: boolean }>
>;

/** What a feature that contributes sub-rows adds to the table's rows. */
export type SubRowsKind = Readonly<{
  /** What a row opens to, in a sentence: "child records". */
  noun: string;
  /** Whether a row has anything to open; a row with nothing shows no toggle. */
  expandable: (row: DisplayRow) => boolean;
}>;

/** One row of the shown list: a record at some level, or a notice beneath its parent. */
export type RowLine =
  | Readonly<{
      kind: "row";
      id: string;
      row: DisplayRow;
      /** 1 for a row of the page, one more for each level beneath it. */
      level: number;
      posinset: number;
      /** The level's size, or -1 while more of its rows remain unread. */
      setsize: number;
      parentId: string | undefined;
      expandable: boolean;
      expanded: boolean;
    }>
  | Readonly<{ kind: "notice"; id: string; level: number; parentId: string; notice: SubRowNotice }>;

/** The sub-rows the grid and the cards show, and the one toggle that opens and closes them. */
export type SubRowsControls = Readonly<{
  noun: string;
  toggle: (recordId: string) => void;
}>;

/** How far each level beneath a page row is indented, in the grid's first column and the cards. */
export const SUB_ROW_INDENT_REM = 1.25;

const noBeneath: SubRowsBeneath = new Map();

type OpenRows = Readonly<{
  kind: SubRowsKind;
  expanded: ReadonlySet<string>;
  beneath: SubRowsBeneath;
}>;

/** The page's rows and, beneath each open row, its entries: one list in tree order. */
const flatten = (
  rows: readonly DisplayRow[],
  paged: boolean,
  open: OpenRows | undefined,
): readonly RowLine[] => {
  const lines: RowLine[] = [];
  const walk = (
    entries: readonly SubRowEntry[],
    level: number,
    parentId: string | undefined,
    setsize: number,
  ): void => {
    let position = 0;
    for (const entry of entries) {
      if (entry.kind === "notice") {
        if (parentId !== undefined)
          lines.push({ kind: "notice", id: entry.id, level, parentId, notice: entry });
        continue;
      }
      position += 1;
      const id = entry.row.recordId;
      const expandable = open !== undefined && open.kind.expandable(entry.row);
      const expanded = expandable && open.expanded.has(id);
      lines.push({
        kind: "row",
        id,
        row: entry.row,
        level,
        posinset: position,
        setsize,
        parentId,
        expandable,
        expanded,
      });
      const below = expanded ? open.beneath.get(id) : undefined;
      if (below !== undefined)
        walk(
          below.entries,
          level + 1,
          id,
          below.complete
            ? below.entries.filter((candidate) => candidate.kind === "row").length
            : -1,
        );
    }
  };
  walk(
    rows.map((row): SubRowEntry => ({ kind: "row", row })),
    1,
    undefined,
    paged ? -1 : rows.length,
  );
  return lines;
};

/**
 * The rows a table shows, in order: the page's rows and, while a feature contributes sub-rows, the
 * entries beneath every open row. The feature's controller (drawn once, drawing nothing) reads what
 * the open rows need and reports it; the grid and the cards draw this one list. An open row leaves
 * the list's open set when it leaves the shown list, so a new page, a closed parent or a searched
 * (flat) list starts with none open.
 */
export const useRowLines = (
  input: Readonly<{
    /** The sub-rows kind of the projected feature; undefined while none contributes any. */
    kind: SubRowsKind | undefined;
    enabled: boolean;
    rows: readonly DisplayRow[];
    paged: boolean;
    rowName: (row: DisplayRow) => string;
    announce: (message: string) => void;
    /** Draws the feature's controller for the open rows; it reports through `publish`. */
    controller: (
      expandedRecordIds: readonly string[],
      publish: (beneath: SubRowsBeneath) => void,
    ) => ReactNode;
  }>,
): Readonly<{
  lines: readonly RowLine[];
  subRows: SubRowsControls | undefined;
  controller: ReactNode;
}> => {
  const { kind, enabled, rows, paged, rowName, announce, controller } = input;
  const active = enabled ? kind : undefined;
  const [expanded, setExpanded] = useState<readonly string[]>([]);
  const [beneath, setBeneath] = useState<SubRowsBeneath>(noBeneath);
  const lines = useMemo(
    () =>
      flatten(
        rows,
        paged,
        active === undefined ? undefined : { kind: active, expanded: new Set(expanded), beneath },
      ),
    [rows, paged, active, expanded, beneath],
  );
  const openableSignature = lines
    .flatMap((line) => (line.kind === "row" && line.expandable ? [line.id] : []))
    .join("\u0000");
  useEffect(() => {
    const shown = new Set(openableSignature.split("\u0000"));
    setExpanded((current) =>
      current.every((recordId) => shown.has(recordId))
        ? current
        : current.filter((recordId) => shown.has(recordId)),
    );
  }, [openableSignature]);
  const toggle = useCallback(
    (recordId: string) => {
      const line = lines.find((candidate) => candidate.id === recordId);
      const name = line?.kind === "row" ? rowName(line.row) : "A row";
      if (expanded.includes(recordId)) {
        setExpanded(expanded.filter((candidate) => candidate !== recordId));
        announce(`${name} collapsed`);
        return;
      }
      setExpanded([...expanded, recordId]);
      announce(`${name} expanded`);
    },
    [lines, expanded, rowName, announce],
  );
  const noun = active?.noun;
  const subRows = useMemo(
    () => (noun === undefined ? undefined : { noun, toggle }),
    [noun, toggle],
  );
  return {
    lines,
    subRows,
    controller: active === undefined ? null : controller(expanded, setBeneath),
  };
};
