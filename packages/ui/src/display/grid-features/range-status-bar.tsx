"use client";

import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  recordsRangeSummaryResultSchema,
  type RecordsRangeSummaryField,
  type RecordsTableStatusBarOperation,
} from "@vortex/platform/schema";
import { Badge } from "../../components/badge";
import type { GridFeatureContext } from "./registry";

/** The settled range this bar totals: the shown rows and columns, as indices into the shown lines. */
export type StatusBarRange = Readonly<{
  firstRow: number;
  lastRow: number;
  firstColumn: number;
  lastColumn: number;
}>;

type Summary =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "ready"; fields: readonly RecordsRangeSummaryField[] }>
  | Readonly<{ status: "refused" }>
  | Readonly<{ status: "page_rows_only" }>;

/** A range settles for this long before the server is asked for its totals. */
const settleMilliseconds = 250;

const operationLabels: Readonly<Record<RecordsTableStatusBarOperation, string>> = {
  count: "Count",
  sum: "Sum",
  average: "Average",
  minimum: "Minimum",
  maximum: "Maximum",
};

const sameField = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

/** The text of the status bar for screen readers: one sentence per field. */
const readout = (
  fields: readonly RecordsRangeSummaryField[],
  labelOf: (fieldId: string) => string,
): string =>
  fields
    .map((field) =>
      field.state === "withheld"
        ? `${labelOf(field.fieldId)}: Not available`
        : `${labelOf(field.fieldId)}: ${field.totals
            .map(
              ({ operation, total }) =>
                `${operationLabels[operation]} ${
                  total.kind === "value"
                    ? total.text
                    : total.kind === "none"
                      ? "no values"
                      : "mixed currencies"
                }`,
            )
            .join(", ")}`,
    )
    .join(". ");

/**
 * The totals of the selected range. One debounced, cancellable request asks the server, which
 * reads the shown page once and totals the selected rows; nothing here adds up a value. A range
 * that moves on aborts the request in flight, and a field the person cannot read is "Not available".
 */
export function RangeStatusBar({
  context,
  range,
}: Readonly<{
  context: GridFeatureContext;
  range: StatusBarRange | undefined;
}>): ReactElement | null {
  const statusBar = context.features.spreadsheet?.statusBar;
  const request = context.events?.range_summary_requested;
  const [summary, setSummary] = useState<Summary | undefined>(undefined);

  // What the range covers: only rows of the shown page can be totalled by the server.
  const target = useMemo(() => {
    if (statusBar === undefined || range === undefined) return undefined;
    const lines = context.lines.slice(range.firstRow, range.lastRow + 1);
    const fieldIds = context.columns
      .slice(range.firstColumn, range.lastColumn + 1)
      .flatMap((column) =>
        statusBar.fields.some((field) => sameField(field, column.key)) ? [column.key] : [],
      );
    if (fieldIds.length === 0) return undefined;
    const pageRows = lines.flatMap((line) =>
      line.kind === "row" && line.level === 1 ? [line.row.recordId] : [],
    );
    return { fieldIds, recordIds: pageRows, pageOnly: pageRows.length === lines.length };
  }, [context.lines, context.columns, range, statusBar]);

  const key =
    target === undefined ? undefined : `${target.recordIds.join(",")}|${target.fieldIds.join(",")}`;
  useEffect(() => {
    if (target === undefined || request === undefined) {
      setSummary(undefined);
      return;
    }
    if (!target.pageOnly || target.recordIds.length === 0) {
      setSummary({ status: "page_rows_only" });
      return;
    }
    const controller = new AbortController();
    setSummary({ status: "loading" });
    const timer = window.setTimeout(() => {
      void Promise.resolve(
        request({
          event: "range_summary_requested",
          recordIds: target.recordIds,
          fieldIds: target.fieldIds,
          signal: controller.signal,
        }),
      )
        .then((answer) => {
          if (controller.signal.aborted) return;
          const parsed = recordsRangeSummaryResultSchema.safeParse(answer);
          setSummary(
            parsed.success && parsed.data.kind === "summarised"
              ? { status: "ready", fields: parsed.data.fields }
              : { status: "refused" },
          );
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          console.error("[grid] the range totals could not be read", error);
          setSummary({ status: "refused" });
        });
    }, settleMilliseconds);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // The key stands for the range's identities and columns; the target object changes each render.
  }, [key, request]);

  if (statusBar === undefined || summary === undefined) return null;
  const labelOf = (fieldId: string): string =>
    context.columns.find((column) => sameField(column.key, fieldId))?.label ?? fieldId;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy={summary.status === "loading"}
      aria-label="Selection totals"
      className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
    >
      {summary.status === "loading" ? <span>Totalling…</span> : null}
      {summary.status === "refused" ? <span>Totals are not available right now.</span> : null}
      {summary.status === "page_rows_only" ? (
        <span>Totals cover the rows of this page, not rows opened beneath them.</span>
      ) : null}
      {summary.status === "ready" ? (
        <>
          <span className="sr-only">{readout(summary.fields, labelOf)}</span>
          {summary.fields.map((field) => (
            <Badge key={field.fieldId} variant="outline" className="gap-1 font-normal" aria-hidden>
              <span className="font-medium text-foreground">{labelOf(field.fieldId)}</span>
              {field.state === "withheld" ? (
                <span>Not available</span>
              ) : (
                field.totals.map(({ operation, total }) => (
                  <span key={operation}>
                    {operationLabels[operation]}{" "}
                    {total.kind === "value"
                      ? total.text
                      : total.kind === "none"
                        ? "no values"
                        : "mixed currencies"}
                  </span>
                ))
              )}
            </Badge>
          ))}
        </>
      ) : null}
    </div>
  );
}
