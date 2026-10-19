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
import {
  fail,
  isInternalAddress,
  parseFields,
  requireArray,
  requireExactKeys,
  requireNonEmptyString,
  requireRecord,
  type DisplayCellValue,
  type DisplayColumn,
  type DisplayField,
} from "../projected-data";
import type { GridFeatureModule, GridFeatureRowProps } from "./registry";

type RelatedRow = Readonly<{ recordId: string; href?: string; fields: readonly DisplayField[] }>;
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
  const record = requireRecord(value, "Related records must be an object", location);
  switch (record.status) {
    case "empty":
    case "refused":
    case "error":
      requireExactKeys(record, ["status"], location);
      return { status: record.status };
    case "ready": {
      requireExactKeys(record, ["status", "columns", "rows", "nextContinuationToken"], location);
      const columns = requireArray(record.columns, "Related columns must be a list", location).map(
        (column) => {
          const entry = requireRecord(column, "A related column must be an object", location);
          requireExactKeys(entry, ["key", "label"], location);
          return {
            key: requireNonEmptyString(entry.key, "A related column needs its key", location),
            label: requireNonEmptyString(entry.label, "A related column needs its label", location),
          };
        },
      );
      const rows = requireArray(record.rows, "Related rows must be a list", location).map(
        (row): RelatedRow => {
          const entry = requireRecord(row, "A related row must be an object", location);
          requireExactKeys(entry, ["recordId", "href", "fields"], location);
          const href = entry.href;
          if (href !== undefined && !isInternalAddress(href))
            fail("A related record's page must be in this application", location);
          return {
            recordId: requireNonEmptyString(
              entry.recordId,
              "A related row needs its record",
              location,
            ),
            ...(href === undefined ? {} : { href: href as string }),
            fields: parseFields(entry.fields, location),
          };
        },
      );
      const next = record.nextContinuationToken;
      return {
        status: "ready",
        page: {
          columns,
          rows,
          ...(next === undefined
            ? {}
            : { next: requireNonEmptyString(next, "The next page needs its token", location) }),
        },
      };
    }
    default:
      return fail("Related records have an unknown status", location);
  }
};

const cellOf = (row: RelatedRow, column: DisplayColumn): DisplayCellValue =>
  row.fields.find((field) => field.key.toLowerCase() === column.key.toLowerCase())?.value ?? {
    kind: "empty",
  };

/**
 * The related records of one expanded row: the records of another record type that link to it,
 * read only while the row is expanded (one read when it opens, one per "Show more"; nothing when
 * it collapses). Each value is drawn by the table's own cell renderer, the first column opens the
 * related record's page when the viewer may open it, and loading, empty, refused and failed reads
 * each have their own state.
 */
function RelatedRecords({ context, row }: GridFeatureRowProps): ReactElement {
  const read = context.events?.row_expanded;
  const pageSize = context.features.masterDetail?.pageSize;
  if (pageSize === undefined) fail("Related records require their feature projection", location);
  const [state, setState] = useState<PanelState>({ kind: "loading" });
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
    void open();
    return () => {
      mounted.current = false;
    };
  }, [open]);

  const showMore = async (): Promise<void> => {
    if (state.kind !== "ready" || state.page.next === undefined || state.more === "reading") return;
    const shown = state.page;
    setState({ kind: "ready", page: shown, more: "reading" });
    const outcome = await readPage(shown.next);
    if (!mounted.current || outcome === undefined) return;
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
          : { kind: "ready", page: shown, more: "failed" },
    );
  };

  if (state.kind === "loading")
    return (
      <div role="status" aria-label="Reading related records" className="flex flex-col gap-2 py-1">
        {Array.from({ length: pageSize }, (_, index) => (
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
    </div>
  );
}

export const gridFeature: GridFeatureModule = { RowExpansion: RelatedRecords };
