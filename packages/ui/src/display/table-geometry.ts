"use client";

import { useSyncExternalStore } from "react";
import {
  RECORDS_TABLE_COLUMN_MAXIMUM_WIDTH,
  RECORDS_TABLE_COLUMN_MINIMUM_WIDTH,
  RECORDS_TABLE_UNVIRTUALIZED_ROW_LIMIT,
  type RecordsTableColumnContract,
  type RecordsTableContract,
  type RecordsTableDensity,
} from "@vortex/platform/schema";
import { LAYOUT_BREAKPOINT_MEDIA } from "../layout-styles";

/** Row height per authored density, in pixels; every row of a page has exactly this height. */
export const GRID_ROW_HEIGHT: Readonly<Record<RecordsTableDensity, number>> = Object.freeze({
  comfortable: 44,
  compact: 32,
});

/** Starting width of a column per its declared relative width, in pixels. */
const COLUMN_WIDTH: Readonly<Record<RecordsTableColumnContract["width"], number>> = Object.freeze({
  auto: 180,
  narrow: 120,
  medium: 220,
  wide: 320,
});

/** A person resizes a column within the contract's bounds; a stored layout holds the same bounds. */
export const GRID_COLUMN_MIN_WIDTH = RECORDS_TABLE_COLUMN_MINIMUM_WIDTH;
export const GRID_COLUMN_MAX_WIDTH = RECORDS_TABLE_COLUMN_MAXIMUM_WIDTH;
/** The fixed width of the selection and row-actions columns. */
export const GRID_CONTROL_COLUMN_WIDTH = 48;

export const columnWidth = (column: RecordsTableColumnContract): number =>
  COLUMN_WIDTH[column.width];

/** Whether a page of this many rows mounts only the rows in view. */
export const virtualizesRows = (rowCount: number): boolean =>
  rowCount > RECORDS_TABLE_UNVIRTUALIZED_ROW_LIMIT;

/**
 * The bounded viewport's height: the rows scroll inside it, under the sticky header. Bounded by
 * the screen height so a page of two hundred rows never makes the page itself that tall.
 */
export const BOUNDED_VIEWPORT_CLASS = "max-h-[70svh]";

/**
 * Rows a skeleton of a virtualized page draws: those that fill the bounded viewport on a tall
 * screen. The rest of the page is one spacer of their height, so the scroll range is the real one.
 */
export const skeletonWindowRows = (density: RecordsTableDensity): number =>
  Math.ceil(900 / GRID_ROW_HEIGHT[density]);

const subscribeToMedia =
  (query: string) =>
  (notify: () => void): (() => void) => {
    const media = window.matchMedia(query);
    media.addEventListener("change", notify);
    return () => media.removeEventListener("change", notify);
  };
const PHONE_QUERY = LAYOUT_BREAKPOINT_MEDIA.phone;
const subscribeToPhone = subscribeToMedia(PHONE_QUERY);
const subscribeToNothing = (): (() => void) => () => undefined;
const isPhone = (): boolean => window.matchMedia(PHONE_QUERY).matches;
const never = (): boolean => false;
const unknownOnServer = (): undefined => undefined;

/**
 * The presentation the table shows now: the grid, or the phone cards when the definition asks for
 * cards and the viewport is a phone's. While the server renders and the page hydrates the
 * viewport is unknown (`undefined`), and the table shows its declared skeleton rather than one
 * presentation it may replace a moment later; nothing is read twice, because both presentations
 * show the same requested columns.
 */
export const useTablePresentation = (
  contract: RecordsTableContract | undefined,
): "grid" | "cards" | undefined => {
  const cards = contract?.presentation === "grid" && contract.phonePresentation === "cards";
  const phone = useSyncExternalStore<boolean | undefined>(
    cards ? subscribeToPhone : subscribeToNothing,
    cards ? isPhone : never,
    cards ? unknownOnServer : never,
  );
  if (contract?.presentation === "cards") return "cards";
  if (phone === undefined) return undefined;
  return phone ? "cards" : "grid";
};
