"use client";

import { useLayoutEffect, useRef, useState, type ReactElement } from "react";
import type { RecordsTableContract } from "@vortex/platform/schema";
import { Skeleton } from "../components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/table";
import { cn } from "../lib/utils";
import { DisplayHeader } from "./controls";
import type { DisplayEventHandlers } from "./projected-data";

/** How long a loading skeleton stays invisible; the platform stylesheet holds the same delay. */
const SKELETON_DELAY_MS = 200;
/** The most skeleton rows drawn: enough to fill the visible table without inventing a full page. */
const SKELETON_ROW_LIMIT = 10;
/** The most skeleton columns drawn. */
const SKELETON_COLUMN_LIMIT = 8;

/**
 * Whether content now replacing a loading state should enter with the refresh motion: only when
 * the skeleton had become visible (it stays invisible for its first 200ms), so data that arrives
 * quickly simply appears and a slow read fades in where the skeleton stood.
 */
export const useLoadingReveal = (loading: boolean): boolean => {
  const since = useRef<number | undefined>(undefined);
  const [revealed, setRevealed] = useState(false);
  useLayoutEffect(() => {
    if (loading) {
      since.current ??= performance.now();
      return;
    }
    if (since.current === undefined) return;
    const shown = performance.now() - since.current >= SKELETON_DELAY_MS;
    since.current = undefined;
    setRevealed(shown);
  }, [loading]);
  return revealed && !loading;
};

/**
 * The Records table's loading state in the table's own shape: its title row, its search row when
 * it has one, the header row and up to ten rows at the real row height, drawn with the same Table
 * parts, so nothing moves when the rows arrive. It carries no data and keeps the state identity,
 * role and accessible name of the standard loading state.
 */
export function TableLoadingState({
  title,
  accessibleName,
  events,
  contract,
}: Readonly<{
  title: string | undefined;
  accessibleName: string;
  events: DisplayEventHandlers | undefined;
  contract: RecordsTableContract | undefined;
}>): ReactElement {
  const columns = Array.from(
    { length: Math.max(1, Math.min(contract?.columns.length ?? 4, SKELETON_COLUMN_LIMIT)) },
    (_, index) => index,
  );
  const rowCount = Math.max(
    1,
    Math.min(contract?.pageSize ?? SKELETON_ROW_LIMIT, SKELETON_ROW_LIMIT),
  );
  const searchRow = contract?.search === true && events?.search_changed !== undefined;
  return (
    <div
      role="status"
      aria-busy="true"
      data-vortex-display-state="loading"
      aria-label={`Loading ${accessibleName}`}
    >
      <DisplayHeader title={title} accessibleName={accessibleName} events={events} />
      {!searchRow ? null : (
        <div className="mb-2">
          <Skeleton className="h-8 w-full sm:w-48" />
        </div>
      )}
      <Table aria-hidden>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead key={column}>
                <Skeleton className="h-[0.75em] w-16" />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rowCount }, (_, row) => (
            <TableRow key={row}>
              {columns.map((column) => (
                <TableCell key={column}>
                  {/* One text line tall, as a cell's value is, so the row has the real height. */}
                  <div className="flex h-[1lh] items-center">
                    <Skeleton className={cn("h-[0.75em]", column === 0 ? "w-3/4" : "w-1/2")} />
                  </div>
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
