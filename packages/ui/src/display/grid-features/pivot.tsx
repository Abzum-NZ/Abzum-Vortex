"use client";

import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  pivotResultSchema,
  recordsTablePivotFeature,
  type PivotPage,
} from "@vortex/platform/schema";
import { Alert, AlertDescription } from "../../components/alert";
import { Button } from "../../components/button";
import { Empty, EmptyHeader, EmptyTitle } from "../../components/empty";
import { Skeleton } from "../../components/skeleton";
import { ToggleGroup, ToggleGroupItem } from "../../components/toggle-group";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/table";
import { cn } from "../../lib/utils";
import { cellValueToText, DisplayCellView } from "../cell";
import { useDateFormatOptions } from "../date-format-context";
import { parseProjectedPart } from "../projected-data";
import type { GridFeatureModule, GridFeaturePointProps } from "./registry";

type Page = PivotPage;
type Axis = Page["columns"][number];
type Drill = NonNullable<Axis["drill"]>;
type Cell = NonNullable<Page["grandTotal"]>;
type Outcome =
  | Readonly<{ status: "ready"; page: Page }>
  | Readonly<{ status: "empty" | "error" }>
  | Readonly<{ status: "refused"; message: string }>;
type BodyState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; page: Page; refreshing: boolean }>
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "refused"; message: string }>
  | Readonly<{ kind: "error" }>;

const location = { propertyPath: [recordsTablePivotFeature.property] };

/**
 * One page of the pivot as the host's read returned it. A reply the host dropped (a later read for
 * the same table already started) is undefined; anything else that is not a page fails loudly, as
 * every projected payload does.
 */
const parseOutcome = (value: unknown): Outcome | undefined => {
  if (value === undefined) return undefined;
  const result = parseProjectedPart(pivotResultSchema, value, "A pivot is invalid", location);
  if (result.status !== "ready") return result;
  const { status, ...page } = result;
  return { status, page };
};

/** The toolbar switch between the ordinary grid and the pivot of the same records. */
function PivotToggle({ context }: GridFeaturePointProps): ReactElement | null {
  const pivot = context.pivot;
  if (pivot === undefined || context.events?.pivot_requested === undefined) return null;
  const open = pivot.view !== undefined;
  return (
    <ToggleGroup
      aria-label={`View of ${context.accessibleName}`}
      variant="outline"
      size="sm"
      value={[open ? "pivot" : "records"]}
      onValueChange={(values: unknown[]) => {
        if (values[0] === "records") pivot.setView(undefined);
        else if (values[0] === "pivot") pivot.setView({});
      }}
    >
      <ToggleGroupItem value="records">Records</ToggleGroupItem>
      <ToggleGroupItem value="pivot">Pivot</ToggleGroupItem>
    </ToggleGroup>
  );
}

function Value({ cell }: Readonly<{ cell: Cell | null }>): ReactElement {
  if (cell === null) return <span className="text-muted-foreground">–</span>;
  if (cell.kind === "unavailable")
    return (
      <span className="text-muted-foreground" title="This total mixes currencies">
        Mixed currencies
      </span>
    );
  return <DisplayCellView value={cell} />;
}

/**
 * The pivot of the table's records: one server read per opening, per change of the table's search
 * or filters and per page of rows (nothing per cell). Totals come from the same read over the whole
 * filtered set, a cell opens the ordinary grid on exactly the records it counts, and loading, empty,
 * refused and failed reads each have their own state. The pivot keeps its position in the address.
 */
function PivotBody({ context }: GridFeaturePointProps): ReactElement | null {
  const dateFormat = useDateFormatOptions();
  const pivot = context.pivot;
  const read = context.events?.pivot_requested;
  const drill = context.events?.pivot_drilled;
  const settings = context.features.pivot;
  const cursor = pivot?.view?.cursor;
  const open = pivot?.view !== undefined;
  const narrowingKey = JSON.stringify([
    context.narrowing?.search ?? null,
    context.narrowing?.filters ?? [],
  ]);
  const [state, setState] = useState<BodyState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const trail = useRef<(string | undefined)[]>([]);
  // Whether the trail of earlier pages starts at the first rows; an address that opens a later
  // page directly does not say how many rows come before it.
  const anchored = useRef(cursor === undefined);
  if (cursor === undefined) anchored.current = true;
  const narrowingSeen = useRef(narrowingKey);
  const latestPivot = useRef(pivot);
  latestPivot.current = pivot;

  useEffect(() => {
    if (!open) return;
    // Another search or filter starts the pivot at its first rows.
    if (narrowingSeen.current !== narrowingKey) {
      narrowingSeen.current = narrowingKey;
      trail.current = [];
      if (cursor !== undefined) {
        latestPivot.current?.setView({});
        return;
      }
    }
    if (read === undefined) {
      setState({ kind: "error" });
      return;
    }
    let current = true;
    setState((held) =>
      held.kind === "ready"
        ? { kind: "ready", page: held.page, refreshing: true }
        : { kind: "loading" },
    );
    void (async () => {
      let outcome: Outcome | undefined;
      try {
        outcome = parseOutcome(
          await read({ event: "pivot_requested", ...(cursor === undefined ? {} : { cursor }) }),
        );
      } catch (error) {
        console.error("[display] the pivot could not be read", error);
        outcome = { status: "error" };
      }
      // A dropped reply (a later read for this table started) leaves the shown pivot as it was.
      if (!current || outcome === undefined) return;
      setState(
        outcome.status === "ready"
          ? { kind: "ready", page: outcome.page, refreshing: false }
          : outcome.status === "refused"
            ? { kind: "refused", message: outcome.message }
            : { kind: outcome.status },
      );
    })();
    return () => {
      current = false;
    };
  }, [open, cursor, narrowingKey, read, attempt]);

  if (!open || settings === undefined) return null;
  if (state.kind === "loading")
    return (
      <div role="status" aria-label="Reading the pivot" className="flex flex-col gap-2 py-1">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-6 w-full" />
        ))}
      </div>
    );
  if (state.kind === "refused")
    return (
      <Alert role="status">
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  if (state.kind === "error")
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 py-1 text-sm">
        <span className="text-muted-foreground">The pivot could not be read.</span>
        <Button variant="outline" size="sm" onClick={() => setAttempt((count) => count + 1)}>
          Try again
        </Button>
      </div>
    );
  if (state.kind === "empty")
    return (
      <Empty
        role="status"
        className="border border-border text-muted-foreground"
        aria-label={`${context.accessibleName}: nothing to pivot`}
      >
        <EmptyHeader>
          <EmptyTitle>No records to pivot</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  const { page, refreshing } = state;
  const totals = settings.totals;
  const first = trail.current.length * settings.rowPageSize + 1;
  const last = first + page.rows.length - 1;
  const shown = anchored.current
    ? `rows ${first}–${last} of ${page.rowGroupCount}`
    : `${page.rows.length} of ${page.rowGroupCount} rows`;
  const open2 = (filters: readonly Drill[]) => (): void => {
    void drill?.({ event: "pivot_drilled", filters });
  };
  const heading = (axis: Axis, filters: readonly Drill[], recordCount: number | undefined) =>
    axis.drill !== undefined && drill !== undefined ? (
      <button
        type="button"
        className="text-left font-medium underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
        aria-label={`${axis.label}${recordCount === undefined ? "" : `, ${recordCount} records`}`}
        aria-description="Open records"
        onClick={open2(filters)}
      >
        {axis.label}
      </button>
    ) : (
      axis.label
    );
  return (
    <div
      className={cn("flex flex-col gap-2", refreshing && "opacity-60")}
      aria-busy={refreshing}
      data-vortex-pivot=""
    >
      <Table className="text-sm">
        <caption className="sr-only">
          {`${context.accessibleName}: ${page.measureLabel} by ${page.rowLabel} and ${page.columnLabel}`}
        </caption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col">
              {page.rowLabel}
              <span className="font-normal text-muted-foreground"> by {page.columnLabel}</span>
            </TableHead>
            {page.columns.map((column) => (
              <TableHead key={column.key} scope="col" className="text-right">
                {heading(column, column.drill === undefined ? [] : [column.drill], undefined)}
              </TableHead>
            ))}
            {totals ? (
              <TableHead scope="col" className="text-right">
                Total
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {page.rows.map((row) => (
            <TableRow key={row.key}>
              <TableHead scope="row" className="sticky left-0 z-10 bg-card font-normal">
                {heading(row, row.drill === undefined ? [] : [row.drill], row.count)}
              </TableHead>
              {row.cells.map((cell, index) => {
                const column = page.columns[index]!;
                const both =
                  row.drill !== undefined && column.drill !== undefined
                    ? [row.drill, column.drill]
                    : undefined;
                return (
                  <TableCell key={column.key} className="text-right tabular-nums">
                    {both !== undefined && cell !== null && drill !== undefined ? (
                      <button
                        type="button"
                        className="w-full text-right underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
                        aria-label={`${cell.kind === "unavailable" ? "Mixed currencies" : cellValueToText(cell, dateFormat)}, ${row.label}, ${column.label}`}
                        aria-description="Open records"
                        onClick={open2(both)}
                      >
                        <Value cell={cell} />
                      </button>
                    ) : (
                      <Value cell={cell} />
                    )}
                  </TableCell>
                );
              })}
              {totals ? (
                <TableCell className="text-right font-medium tabular-nums">
                  <Value cell={row.total ?? null} />
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
        {totals && page.columnTotals !== undefined ? (
          <TableFooter>
            <TableRow>
              <TableHead scope="row">Total</TableHead>
              {page.columnTotals.map((cell, index) => (
                <TableCell key={page.columns[index]!.key} className="text-right tabular-nums">
                  <Value cell={cell} />
                </TableCell>
              ))}
              <TableCell className="text-right tabular-nums">
                <Value cell={page.grandTotal ?? null} />
              </TableCell>
            </TableRow>
          </TableFooter>
        ) : null}
      </Table>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 text-xs text-muted-foreground tabular-nums" role="status">
          {`${page.measureLabel} · ${shown} · ${page.totalRecords} ${page.totalRecords === 1 ? "record" : "records"}`}
        </p>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={cursor === undefined || refreshing}
            onClick={() => {
              trail.current = [];
              pivot?.setView({});
            }}
          >
            First
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={cursor === undefined || refreshing}
            onClick={() => {
              const previous = trail.current.pop();
              pivot?.setView(previous === undefined ? {} : { cursor: previous });
            }}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page.nextCursor === undefined || refreshing}
            onClick={() => {
              if (page.nextCursor === undefined) return;
              trail.current.push(cursor);
              pivot?.setView({ cursor: page.nextCursor });
            }}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}

export const gridFeature: GridFeatureModule = { ToolbarItems: PivotToggle, ViewBody: PivotBody };
