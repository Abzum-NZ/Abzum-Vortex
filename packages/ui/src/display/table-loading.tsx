"use client";

import { useLayoutEffect, useRef, useState, type ReactElement } from "react";
import type { RecordsTableContract, RecordsTableDensity } from "@vortex/platform/schema";
import { Card } from "../components/card";
import { Skeleton } from "../components/skeleton";
import { cn } from "../lib/utils";
import {
  BOUNDED_VIEWPORT_CLASS,
  CARD_SPACING,
  GRID_CONTROL_COLUMN_WIDTH,
  GRID_ROW_HEIGHT,
  columnWidth,
  skeletonWindowRows,
  virtualizesRows,
} from "./table-geometry";

/** How long a loading skeleton stays invisible; the platform stylesheet holds the same delay. */
const SKELETON_DELAY_MS = 200;

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
 * The Records table's loading state in the exact geometry of the page it waits for: every
 * declared default column at its declared width, a selection or actions column where the table
 * has one, and one row per record of the authored page size at the authored density, inside the
 * same viewport. A page of more than one hundred rows draws only the rows that fill the viewport
 * and one spacer for the rest, as the loaded grid mounts only its window. On a phone that shows
 * cards it draws cards instead. It carries no data and keeps the state identity, role and
 * accessible name of the standard loading state.
 */
export function TableLoadingState({
  accessibleName,
  contract,
  density,
  presentation,
  selectionColumn,
  actionsColumn,
}: Readonly<{
  accessibleName: string;
  contract: RecordsTableContract;
  density: RecordsTableDensity;
  presentation: "grid" | "cards";
  selectionColumn: boolean;
  actionsColumn: boolean;
}>): ReactElement {
  const rowHeight = GRID_ROW_HEIGHT[density];
  const windowed = virtualizesRows(contract.pageSize);
  const drawnRows = windowed
    ? Math.min(contract.pageSize, skeletonWindowRows(density))
    : contract.pageSize;
  const columns = contract.columns.filter((column) => column.visible);
  const state = {
    role: "status",
    "aria-busy": true,
    "aria-label": `Loading ${accessibleName}`,
    "data-vortex-display-state": "loading",
  } as const;

  if (presentation === "cards")
    return (
      <div {...state} className="flex flex-col gap-2">
        {Array.from({ length: drawnRows }, (_, card) => (
          <Card key={card} size="sm" className={CARD_SPACING[density]}>
            <Skeleton className="h-[0.875em] w-2/3" />
            {columns.slice(1).map((column) => (
              <div key={column.field} className="flex items-center justify-between gap-4">
                <Skeleton className="h-[0.75em] w-1/4" />
                <Skeleton className="h-[0.75em] w-1/3" />
              </div>
            ))}
          </Card>
        ))}
      </div>
    );

  const widths = [
    ...(selectionColumn ? [GRID_CONTROL_COLUMN_WIDTH] : []),
    ...columns.map(columnWidth),
    ...(actionsColumn ? [GRID_CONTROL_COLUMN_WIDTH] : []),
  ];
  const total = widths.reduce((sum, width) => sum + width, 0);
  const row = (key: number, header: boolean): ReactElement => (
    <div
      key={key}
      className={cn("flex w-full border-b", header && "bg-muted")}
      style={{ height: rowHeight }}
    >
      {widths.map((width, index) => (
        <div
          key={index}
          className="flex items-center px-2"
          style={{ flex: `${width} 0 ${width}px` }}
        >
          <Skeleton
            className={cn("h-[0.75em]", header ? "w-16" : index === 0 ? "w-3/4" : "w-1/2")}
          />
        </div>
      ))}
    </div>
  );
  return (
    <Card
      {...state}
      className={cn(
        "relative max-w-full gap-0 overflow-hidden py-0",
        contract.viewport === "bounded" && BOUNDED_VIEWPORT_CLASS,
      )}
    >
      <div aria-hidden="true" style={{ width: total, minWidth: "100%" }}>
        {row(-1, true)}
        {Array.from({ length: drawnRows }, (_, index) => row(index, false))}
        {drawnRows === contract.pageSize ? null : (
          <div style={{ height: (contract.pageSize - drawnRows) * rowHeight }} />
        )}
      </div>
    </Card>
  );
}
