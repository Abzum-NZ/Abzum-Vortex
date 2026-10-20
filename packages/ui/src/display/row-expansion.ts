"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { RowPanelMemory } from "./grid-features/registry";
import type { DisplayRow } from "./projected-data";

/** At most this many rows of one table show their related records at once. */
export const MAXIMUM_EXPANDED_ROWS = 3;

/**
 * Which rows of the shown page are expanded, and the panel each draws. The grid and the cards take
 * the same controls; only expanded rows draw a panel, and only a drawn panel reads anything.
 */
export type RowExpansionControls = Readonly<{
  expandedRecordIds: readonly string[];
  isExpanded: (recordId: string) => boolean;
  toggle: (recordId: string) => void;
  panel: (row: DisplayRow) => ReactNode;
  /** The id of a row's panel, for the toggle's `aria-controls`. */
  panelId: (recordId: string) => string;
}>;

/**
 * The expanded rows of one table, oldest first. Expanding a fourth row collapses the oldest and says
 * so; a row that leaves the page collapses with it, so a new page starts with none expanded.
 */
export const useRowExpansion = (
  input: Readonly<{
    enabled: boolean;
    placementId: string;
    rows: readonly DisplayRow[];
    rowName: (row: DisplayRow) => string;
    announce: (message: string) => void;
    panel: (row: DisplayRow, memory: RowPanelMemory) => ReactNode;
  }>,
): RowExpansionControls | undefined => {
  const { enabled, placementId, rows, rowName, announce, panel } = input;
  const [expanded, setExpanded] = useState<readonly string[]>([]);
  // What each open row's panel keeps; an entry lives exactly as long as its row stays expanded.
  const kept = useRef(new Map<string, unknown>());
  useEffect(() => {
    for (const recordId of [...kept.current.keys()])
      if (!expanded.includes(recordId)) kept.current.delete(recordId);
  }, [expanded]);
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
      if (next.length <= MAXIMUM_EXPANDED_ROWS) {
        setExpanded(next);
        announce(`${nameOf(recordId)} expanded`);
        return;
      }
      const [oldest, ...kept] = next;
      setExpanded(kept);
      announce(
        `${nameOf(recordId)} expanded. ${nameOf(oldest!)} collapsed, as at most ${MAXIMUM_EXPANDED_ROWS} rows stay open.`,
      );
    },
    [expanded, announce, nameOf],
  );
  const drawPanel = useCallback(
    (row: DisplayRow) =>
      panel(row, {
        kept: () => kept.current.get(row.recordId),
        keep: (value: unknown) => {
          kept.current.set(row.recordId, value);
        },
      }),
    [panel],
  );
  return useMemo(
    () =>
      enabled
        ? {
            expandedRecordIds: expanded,
            isExpanded: (recordId: string) => expanded.includes(recordId),
            toggle,
            panel: drawPanel,
            panelId: (recordId: string) => `${placementId}-related-${recordId}`,
          }
        : undefined,
    [enabled, expanded, toggle, drawPanel, placementId],
  );
};
