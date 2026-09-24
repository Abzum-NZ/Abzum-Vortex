"use client";

import { createContext, useContext } from "react";
import { cellValueToText } from "../display/cell";
import type { DisplayRow } from "../display/projected-data";

export const VIEW_FILTER_MATCH_MODES = ["contains", "starts_with", "exact"] as const;
export type ViewFilterMatchMode = (typeof VIEW_FILTER_MATCH_MODES)[number];

/**
 * The local narrowing an enclosing `view_filter` applies to the launcher and tile placements in its
 * content slot. It only tests rows those placements already received; it holds no data of its own
 * and can never add a row, broaden a projection or ask for another read.
 */
export type LauncherRowFilter = Readonly<{
  /** True when the row stays visible; `defaultMatchKey` is the placement's own name cell. */
  matches: (row: DisplayRow, defaultMatchKey: string) => boolean;
  /** Authored text shown by a placement whose returned rows all fall outside the filter. */
  emptyMessage: string;
}>;

export const LauncherRowFilterContext = createContext<LauncherRowFilter | undefined>(undefined);

/** The nearest enclosing view filter, if any. */
export const useLauncherRowFilter = (): LauncherRowFilter | undefined =>
  useContext(LauncherRowFilterContext);

/**
 * Creates one view filter's row test. An empty query keeps every row; otherwise a row stays only
 * when its match cell's text matches and every enclosing filter also keeps it, so nesting can only
 * narrow further.
 */
export function createLauncherRowFilter(
  options: Readonly<{
    query: string;
    matchKey: string | undefined;
    mode: ViewFilterMatchMode;
    caseSensitive: boolean;
    emptyMessage: string;
    enclosing: LauncherRowFilter | undefined;
  }>,
): LauncherRowFilter {
  const { matchKey, mode, caseSensitive, enclosing } = options;
  const needle = caseSensitive ? options.query.trim() : options.query.trim().toLowerCase();
  const ownMatch = (row: DisplayRow, defaultMatchKey: string): boolean => {
    if (needle.length === 0) return true;
    const cell = row.cells[matchKey ?? defaultMatchKey];
    if (cell === undefined) return false;
    const text = caseSensitive ? cellValueToText(cell) : cellValueToText(cell).toLowerCase();
    switch (mode) {
      case "starts_with":
        return text.startsWith(needle);
      case "exact":
        return text === needle;
      case "contains":
        return text.includes(needle);
    }
  };
  return Object.freeze({
    matches: (row: DisplayRow, defaultMatchKey: string): boolean =>
      ownMatch(row, defaultMatchKey) && (enclosing?.matches(row, defaultMatchKey) ?? true),
    emptyMessage: options.emptyMessage,
  });
}

/** The rows a placement shows under its nearest view filter; never more than it received. */
export function filterLauncherRows(
  rows: readonly DisplayRow[],
  filter: LauncherRowFilter | undefined,
  defaultMatchKey: string,
): readonly DisplayRow[] {
  return filter === undefined ? rows : rows.filter((row) => filter.matches(row, defaultMatchKey));
}
