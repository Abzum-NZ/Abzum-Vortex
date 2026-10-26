"use client";

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Button } from "../../components/button";
import { Empty, EmptyHeader, EmptyTitle } from "../../components/empty";
import { Skeleton } from "../../components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/table";
import { cellValueToText, DisplayCellView } from "../cell";
import type { RowDetailReply } from "@vortex/platform/schema";
import { fail } from "../payload-parse";
import {
  isInternalAddress,
  readProjectedResult,
  REPLY_ENVELOPES,
  type DisplayColumn,
  type DisplayDetailCell,
  type DisplayDetailField,
} from "../projected-data";
import type { GridFeatureModule, GridFeatureRowProps } from "./registry";

type RelatedRow = Readonly<{
  recordId: string;
  href?: string;
  fields: readonly DisplayDetailField[];
}>;
type RelatedPage = Readonly<{
  columns: readonly DisplayColumn[];
  rows: readonly RelatedRow[];
  next?: string;
}>;
type Outcome =
  | Readonly<{ status: "ready"; page: RelatedPage }>
  | Readonly<{ status: "empty" | "refused" | "error" }>;
type PanelState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; page: RelatedPage; more: "idle" | "reading" | "failed" }>
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "error" }>;

const location = { propertyPath: ["related_records"] };

/**
 * One page of related records as the host's read returned it. A reply the host dropped (a later
 * read for the same row already started) is undefined; anything else that is not a page fails
 * loudly, as every projected payload does.
 */
const parseOutcome = (value: unknown): Outcome | undefined => {
  if (value === undefined) return undefined;
  const result = readProjectedResult<RowDetailReply>(
    value,
    REPLY_ENVELOPES.rowDetail,
    "Related records are invalid",
    location,
  );
  if (result.status !== "ready") return { status: result.status };
  // A related record opens a page of this application; any other address is refused.
  if (result.rows.some((row) => row.href !== undefined && !isInternalAddress(row.href)))
    return fail("A related record's page must be in this application", location);
  const next = result.nextContinuationToken;
  return {
    status: "ready",
    page: {
      columns: result.columns,
      rows: result.rows,
      ...(next === undefined ? {} : { next }),
    },
  };
};

const cellOf = (row: RelatedRow, column: DisplayColumn): DisplayDetailCell =>
  row.fields.find((field) => field.key.toLowerCase() === column.key.toLowerCase())?.value ?? {
    kind: "empty",
  };

/** The settled state a panel keeps while its row stays open; a read in flight is not kept. */
const settled = (state: PanelState): PanelState | undefined =>
  state.kind === "loading"
    ? undefined
    : state.kind === "ready" && state.more === "reading"
      ? { ...state, more: "idle" }
      : state;

/**
 * The related records of one expanded row: the records of another record type that link to it,
 * read only while the row is expanded (one read when it opens, one per "Show more"; nothing when
 * it collapses, and nothing when the table swaps between the grid and the phone cards, as the
 * table keeps the shown page for the open row). Each value is drawn by the table's own cell renderer, the first column opens the
 * related record's page when the viewer may open it, and loading, empty, refused and failed reads
 * each have their own state.
 */
function RelatedRecords({ context, row, memory }: GridFeatureRowProps): ReactElement {
  const read = context.events?.row_expanded;
  const pageSize = context.features.masterDetail?.pageSize;
  if (pageSize === undefined) fail("Related records require their feature projection", location);
  // Only this panel writes its memory, so what it holds is a state this panel kept.
  const [state, setState] = useState<PanelState>(
    () => (memory.kept() as PanelState | undefined) ?? { kind: "loading" },
  );
  const reopened = useRef(state.kind !== "loading");
  const mounted = useRef(true);
  const recordId = row.recordId;

  const readPage = useCallback(
    async (token: string | undefined): Promise<Outcome | undefined> => {
      if (read === undefined) return { status: "error" };
      try {
        return parseOutcome(
          await read({
            event: "row_expanded",
            recordId,
            ...(token === undefined ? {} : { continuationToken: token }),
          }),
        );
      } catch (error) {
        console.error("[display] related records could not be read", error);
        return { status: "error" };
      }
    },
    [read, recordId],
  );

  const open = useCallback(async () => {
    setState({ kind: "loading" });
    const outcome = await readPage(undefined);
    if (!mounted.current || outcome === undefined) return;
    setState(
      outcome.status === "ready"
        ? { kind: "ready", page: outcome.page, more: "idle" }
        : { kind: outcome.status },
    );
  }, [readPage]);

  useEffect(() => {
    mounted.current = true;
    if (reopened.current) reopened.current = false;
    else void open();
    return () => {
      mounted.current = false;
    };
  }, [open]);

  useEffect(() => {
    const keep = settled(state);
    if (keep !== undefined) memory.keep(keep);
  }, [memory, state]);

  const showMore = async (): Promise<void> => {
    if (state.kind !== "ready" || state.page.next === undefined || state.more === "reading") return;
    const shown = state.page;
    setState({ kind: "ready", page: shown, more: "reading" });
    const outcome = await readPage(shown.next);
    if (!mounted.current) return;
    // A dropped reply (a later read for this row started) leaves the shown page as it was.
    if (outcome === undefined) {
      setState({ kind: "ready", page: shown, more: "idle" });
      return;
    }
    setState(
      outcome.status === "ready"
        ? {
            kind: "ready",
            page: {
              columns: shown.columns,
              rows: [...shown.rows, ...outcome.page.rows],
              ...(outcome.page.next === undefined ? {} : { next: outcome.page.next }),
            },
            more: "idle",
          }
        : outcome.status === "empty"
          ? { kind: "ready", page: { columns: shown.columns, rows: shown.rows }, more: "idle" }
          : outcome.status === "refused"
            ? { kind: "refused" }
            : { kind: "ready", page: shown, more: "failed" },
    );
  };

  if (state.kind === "loading")
    return (
      <div role="status" aria-label="Reading related records" className="flex flex-col gap-2 py-1">
        {Array.from({ length: Math.min(pageSize, 5) }, (_, index) => (
          <Skeleton key={index} className="h-5 w-full" />
        ))}
      </div>
    );
  if (state.kind === "refused")
    return (
      <p role="status" className="m-0 py-1 text-sm text-muted-foreground">
        You do not have access to these records
      </p>
    );
  if (state.kind === "error")
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 py-1 text-sm">
        <span className="text-muted-foreground">The related records could not be read.</span>
        <Button variant="outline" size="sm" onClick={() => void open()}>
          Try again
        </Button>
      </div>
    );
  if (state.kind === "empty")
    return (
      <Empty role="status" className="p-2 md:p-2">
        <EmptyHeader>
          <EmptyTitle className="text-sm font-normal text-muted-foreground">
            No related records
          </EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  const { page, more } = state;
  const footer = (
    <>
      {page.next === undefined ? null : (
        <Button
          variant="ghost"
          size="sm"
          disabled={more === "reading"}
          onClick={() => void showMore()}
        >
          {more === "reading" ? "Reading…" : "Show more"}
        </Button>
      )}
      {more === "failed" ? (
        <p role="alert" className="m-0 text-sm text-muted-foreground">
          More related records could not be read.
        </p>
      ) : null}
    </>
  );
  if (context.presentation === "cards")
    return (
      <div className="flex min-w-0 flex-col items-start gap-1 text-sm">
        <ul className="m-0 flex w-full min-w-0 list-none flex-col divide-y divide-border p-0">
          {page.rows.map((related) => {
            const [titleColumn, ...detailColumns] = page.columns;
            const titleValue = titleColumn === undefined ? undefined : cellOf(related, titleColumn);
            return (
              <li
                key={related.recordId}
                data-vortex-related-record-id={related.recordId}
                className="min-w-0 py-2 first:pt-0 last:pb-0"
              >
                {titleColumn === undefined ? null : (
                  <h4 className="m-0 min-w-0 font-medium">
                    {titleValue === undefined || related.href === undefined ? (
                      titleValue === undefined ? null : (
                        <DisplayCellView value={titleValue} />
                      )
                    ) : (
                      <a
                        href={related.href}
                        className="underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
                      >
                        {cellValueToText(titleValue) || "Open"}
                      </a>
                    )}
                  </h4>
                )}
                {detailColumns.length === 0 ? null : (
                  <dl className="m-0 mt-1 grid min-w-0 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 gap-y-1">
                    {detailColumns.map((column) => (
                      <div key={column.key} className="contents">
                        <dt className="min-w-0 break-words text-muted-foreground">
                          {column.label}
                        </dt>
                        <dd className="m-0 min-w-0 break-words text-end">
                          <DisplayCellView value={cellOf(related, column)} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </li>
            );
          })}
        </ul>
        {footer}
      </div>
    );
  return (
    <div className="flex flex-col items-start gap-1">
      <Table className="text-sm" containerClassName="border-0 bg-transparent">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {page.columns.map((column) => (
              <TableHead key={column.key} className="h-8 text-xs text-muted-foreground">
                {column.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {page.rows.map((related) => (
            <TableRow key={related.recordId} data-vortex-related-record-id={related.recordId}>
              {page.columns.map((column, index) => {
                const cell = cellOf(related, column);
                return (
                  <TableCell key={column.key} className="max-w-64 truncate py-1.5">
                    {index === 0 && related.href !== undefined ? (
                      <a
                        href={related.href}
                        className="font-medium underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
                      >
                        {cellValueToText(cell) || "Open"}
                      </a>
                    ) : (
                      <DisplayCellView value={cell} />
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {footer}
    </div>
  );
}

export const gridFeature: GridFeatureModule = { RowExpansion: RelatedRecords };
