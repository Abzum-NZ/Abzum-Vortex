"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { DisplayRow } from "./projected-data";

/**
 * What a row opens to and how many rows of a page may be open at once. The related records of a
 * row open at most three at a time; the rows beneath a row are bounded by the table's shared row
 * budget instead, which its panel keeps.
 */
export type RowExpansionKind = Readonly<{
  /** What the panel holds, in a sentence: "related records" or "child records". */
  noun: string;
  maximum: number;
  /** The rows form a tree: the grid is a tree grid and each row says its level. */
  tree: boolean;
  /** Whether a row has anything to open; a row with nothing shows no toggle. */
  expandable: (row: DisplayRow) => boolean;
}>;

const closedKind: RowExpansionKind = {
  noun: "related records",
  maximum: 0,
  tree: false,
  expandable: () => false,
};

/**
 * Which rows of the shown page are expanded, and the panel each draws. The grid and the cards take
 * the same controls; only expanded rows draw a panel, and only a drawn panel reads anything.
 */
export type RowExpansionControls = Readonly<{
  noun: string;
  tree: boolean;
  expandedRecordIds: readonly string[];
  isExpanded: (recordId: string) => boolean;
  /** Whether a row has anything to open. */
  isExpandable: (row: DisplayRow) => boolean;
  toggle: (recordId: string) => void;
  panel: (row: DisplayRow) => ReactNode;
  /** The id of a row's panel, for the toggle's `aria-controls`. */
  panelId: (recordId: string) => string;
}>;

/**
 * The expanded rows of one table, oldest first. Expanding a row beyond the kind's maximum collapses
 * the oldest and says so; a row that leaves the page collapses with it, so a new page starts with
 * none expanded.
 */
export const useRowExpansion = (
  input: Readonly<{
    enabled: boolean;
    /** What a row opens to; undefined while no feature draws a panel. */
    kind: RowExpansionKind | undefined;
    placementId: string;
    rows: readonly DisplayRow[];
    rowName: (row: DisplayRow) => string;
    announce: (message: string) => void;
    panel: (row: DisplayRow) => ReactNode;
  }>,
): RowExpansionControls | undefined => {
  const { enabled, kind, placementId, rows, rowName, announce, panel } = input;
  const { noun, maximum, expandable, tree } = kind ?? closedKind;
  const [expanded, setExpanded] = useState<readonly string[]>([]);
  const pageSignature = rows.map((row) => row.recordId).join("\u0000");
  useEffect(() => {
    const onPage = new Set(pageSignature.split("\u0000"));
    setExpanded((current) =>
      current.every((recordId) => onPage.has(recordId))
        ? current
        : current.filter((recordId) => onPage.has(recordId)),
    );
  }, [pageSignature]);
  const nameOf = useCallback(
    (recordId: string): string => {
      const row = rows.find((candidate) => candidate.recordId === recordId);
      return row === undefined ? "A row" : rowName(row);
    },
    [rows, rowName],
  );
  const toggle = useCallback(
    (recordId: string) => {
      if (expanded.includes(recordId)) {
        setExpanded(expanded.filter((candidate) => candidate !== recordId));
        announce(`${nameOf(recordId)} collapsed`);
        return;
      }
      const next = [...expanded, recordId];
      if (next.length <= maximum) {
        setExpanded(next);
        announce(`${nameOf(recordId)} expanded`);
        return;
      }
      const [oldest, ...kept] = next;
      setExpanded(kept);
      announce(
        `${nameOf(recordId)} expanded. ${nameOf(oldest!)} collapsed, as at most ${maximum} rows stay open.`,
      );
    },
    [expanded, announce, nameOf, maximum],
  );
  return useMemo(
    () =>
      enabled && kind !== undefined
        ? {
            noun,
            tree,
            expandedRecordIds: expanded,
            isExpanded: (recordId: string) => expanded.includes(recordId),
            isExpandable: expandable,
            toggle,
            panel,
            panelId: (recordId: string) => `${placementId}-related-${recordId}`,
          }
        : undefined,
    [enabled, kind, noun, tree, expandable, expanded, toggle, panel, placementId],
  );
};
