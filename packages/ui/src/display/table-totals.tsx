"use client";

import type { ReactElement } from "react";
import { recordsTableAggregateLabels, type RecordsTableTotal } from "@vortex/platform/schema";

export const totalText = (total: RecordsTableTotal): string => {
  switch (total.state) {
    case "value":
      return total.text!;
    case "empty":
      return "No values";
    case "withheld":
      return "Withheld";
    case "mixed_currency":
      return "Mixed currencies";
    case "unavailable":
      return "Not available";
  }
};

/** A column's measures share its footer cell and are named individually for assistive technology. */
export function TotalValues({
  totals,
}: Readonly<{ totals: readonly RecordsTableTotal[] }>): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 py-1 text-xs tabular-nums">
      {totals.map((total) => (
        <span key={`${total.fieldId}:${total.operation}`} className="break-words">
          <span className="text-muted-foreground">
            {recordsTableAggregateLabels[total.operation]}:{" "}
          </span>
          {totalText(total)}
        </span>
      ))}
    </div>
  );
}

/** Group headers and card presentations name columns explicitly; arithmetic stays on the server. */
export function TableTotals({
  totals,
  columns,
  label,
}: Readonly<{
  totals: readonly RecordsTableTotal[];
  columns: readonly Readonly<{ key: string; label: string }>[];
  label: string;
}>): ReactElement | null {
  const shown = columns.flatMap((column) => {
    const measures = totals.filter(
      (total) => total.fieldId.toLowerCase() === column.key.toLowerCase(),
    );
    return measures.length === 0 ? [] : [{ column, measures }];
  });
  if (shown.length === 0) return null;
  return (
    <div
      role="group"
      aria-label={label}
      data-vortex-table-totals=""
      className="border-t border-border px-2 py-1"
    >
      <p className="m-0 text-xs text-muted-foreground">{label}</p>
      <dl className="m-0 flex flex-wrap gap-x-6 gap-y-1">
        {shown.map(({ column, measures }) => (
          <div key={column.key}>
            <dt className="text-xs font-medium">{column.label}</dt>
            <dd className="m-0">
              <TotalValues totals={measures} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
