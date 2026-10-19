"use client";

import { useState, type MouseEvent, type ReactElement, type ReactNode } from "react";
import type { RecordsTableColumnContract } from "@vortex/platform/schema";
import { Card } from "../components/card";
import { cn } from "../lib/utils";
import type { DisplayRow } from "./projected-data";
import { useRowEntrance } from "./row-entrance";
import type { GridColumn } from "./table-layout";

const PRIORITY_ORDER: Readonly<Record<RecordsTableColumnContract["priority"], number>> = {
  essential: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const INTERACTIVE_IN_CARD =
  "a,button,input,select,textarea,label,summary,[role='button'],[role='checkbox'],[role='radio'],[role='menuitem'],[role='switch']";

/** Content renderers the host supplies; the same ones the grid uses. */
export type CardRenderers = Readonly<{
  value: (row: DisplayRow, column: GridColumn) => ReactNode;
  /** Plain text of a value, for the heading that opens the row (a link cannot nest in it). */
  text: (row: DisplayRow, column: GridColumn) => string;
  select: (row: DisplayRow, selected: boolean) => ReactNode;
  actions: (row: DisplayRow) => ReactNode;
}>;

/**
 * The Records table on a phone: one card per record of the same page, built from the columns the
 * page carries. The first shown column is the card's heading; the others follow as labelled values,
 * essential and high priority first. A card opens through the same declared row click, and its
 * selection and row commands send the same events as the grid's. Only this presentation is mounted.
 */
export function RecordsCards({
  accessibleName,
  columns,
  rows,
  selectedRecordIds,
  selectable,
  showActions,
  activateRow,
  renderers,
  fill,
}: Readonly<{
  accessibleName: string;
  columns: readonly GridColumn[];
  rows: readonly DisplayRow[];
  selectedRecordIds: readonly string[];
  selectable: boolean;
  showActions: boolean;
  activateRow: ((recordId: string) => unknown) | undefined;
  renderers: CardRenderers;
  fill: boolean;
}>): ReactElement {
  const [heading, ...rest] = columns;
  const details = rest
    .map((column, order) => ({ column, order }))
    .sort(
      (left, right) =>
        PRIORITY_ORDER[left.column.declared.priority] -
          PRIORITY_ORDER[right.column.declared.priority] || left.order - right.order,
    )
    .map(({ column }) => column);
  const [pending, setPending] = useState<string | undefined>(undefined);
  const activate = (recordId: string): void => {
    if (activateRow === undefined || pending !== undefined) return;
    const outcome = activateRow(recordId);
    if (
      typeof outcome === "object" &&
      outcome !== null &&
      typeof (outcome as PromiseLike<unknown>).then === "function"
    ) {
      setPending(recordId);
      const settle = (): void => setPending(undefined);
      (outcome as PromiseLike<unknown>).then(settle, settle);
    }
  };
  const listRef = useRowEntrance<HTMLUListElement>(
    rows.map((row) => row.recordId),
    "li[data-vortex-record-id]",
  );
  return (
    <ul
      ref={listRef}
      aria-label={accessibleName}
      className={cn(
        "m-0 flex list-none flex-col gap-2 p-0",
        fill && "min-h-0 flex-1 overflow-auto",
      )}
    >
      {rows.map((row) => {
        const selected = selectedRecordIds.includes(row.recordId);
        const headingId = `record-${row.recordId}-heading`;
        return (
          <li
            key={row.recordId}
            id={`record-${row.recordId}`}
            data-vortex-record-id={row.recordId}
            data-state={selected ? "selected" : undefined}
            aria-labelledby={headingId}
            aria-busy={pending === row.recordId ? true : undefined}
            className={cn(
              activateRow !== undefined && "cursor-pointer",
              pending === row.recordId && "cursor-progress opacity-60",
            )}
            onClick={(event: MouseEvent<HTMLLIElement>) => {
              const target = event.target;
              if (target instanceof Element && target.closest(INTERACTIVE_IN_CARD) !== null) return;
              activate(row.recordId);
            }}
          >
            <Card size="sm" className={cn("gap-2 p-3", selected && "ring-2 ring-primary")}>
              <div className="flex min-w-0 items-center gap-2">
                {selectable ? renderers.select(row, selected) : null}
                <h3 id={headingId} className="m-0 min-w-0 flex-1 truncate text-sm font-medium">
                  {activateRow === undefined || heading === undefined ? (
                    heading === undefined ? null : (
                      renderers.value(row, heading)
                    )
                  ) : (
                    <button
                      type="button"
                      className="max-w-full truncate text-start font-medium underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
                      onClick={() => activate(row.recordId)}
                    >
                      {renderers.text(row, heading)}
                    </button>
                  )}
                </h3>
                {showActions ? renderers.actions(row) : null}
              </div>
              {details.length === 0 ? null : (
                <dl className="m-0 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 gap-y-1">
                  {details.map((column) => (
                    <div key={column.key} className="contents">
                      <dt className="truncate text-muted-foreground">{column.label}</dt>
                      <dd className="m-0 min-w-0 truncate text-end">
                        {renderers.value(row, column)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
