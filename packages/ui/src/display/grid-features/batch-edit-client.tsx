"use client";

import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { FlowRuntimeStateContext } from "../../flow-runtime/flow-runtime-state-context";
import { createFlowRuntimeState } from "../../flow-runtime/flow-runtime";
import {
  recordsTableBatchEditMaximumFields,
  recordsTableBatchEditMaximumRows,
  recordsTableBatchEditResultSchema,
  type JsonValue,
  type RecordsTableBatchEditProblem,
  type RecordsTableBatchEditRequest,
  type RecordsTableInlineEditor,
} from "@vortex/platform/schema";
import { Alert, AlertDescription, AlertTitle } from "../../components/alert";
import { Button } from "../../components/button";
import { GRID_ROOT, isInteractiveGridTarget } from "../table-interaction";
import type { DisplayBatchEditAnswer, DisplayRow } from "../projected-data";
import type { GridColumn } from "../table-layout";
import type { GridFeatureContext, GridInteractionSurface } from "./registry";

/**
 * What Paste, Fill and Undo share: the rectangle the range selection painted, the cells of the
 * loaded page that may be edited, the one request a batch is, and the notice that marks every cell
 * the server (or this check) refused. Nothing here decides validity: the client only stops input
 * that cannot be a batch (past the page, past the limits, read-only) before a request is made, and
 * the server checks every cell again and commits all of the batch or none of it.
 */

type BatchRows = RecordsTableBatchEditRequest["rows"];

export type BatchTarget = Readonly<{
  /** Index in `context.lines`, which is the cell's `data-row`. */
  line: number;
  row: DisplayRow & Readonly<{ revision: number }>;
  column: GridColumn;
  editor: RecordsTableInlineEditor;
  stored: JsonValue | undefined;
}>;

/** A cell the batch cannot change, with the sentence the person is shown. */
export type BatchProblem = Readonly<{
  line: number;
  recordId: string;
  field: string | undefined;
  message: string;
}>;

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/** The settled rectangle as line and column indexes, read from the cells the range painted. */
export const paintedRange = (
  root: HTMLElement,
  context: GridFeatureContext,
):
  | Readonly<{ firstLine: number; lastLine: number; firstColumn: number; lastColumn: number }>
  | undefined => {
  const keys = context.columns.map((column) => column.key);
  let firstLine = Infinity;
  let lastLine = -Infinity;
  let firstColumn = Infinity;
  let lastColumn = -Infinity;
  for (const cell of root.querySelectorAll<HTMLElement>("[data-grid-cell][aria-selected='true']")) {
    if (cell.closest(GRID_ROOT) !== root) continue;
    const line = Number(cell.dataset.row);
    const column = keys.indexOf(cell.dataset.col ?? "");
    if (!Number.isInteger(line) || column < 0) continue;
    firstLine = Math.min(firstLine, line);
    lastLine = Math.max(lastLine, line);
    firstColumn = Math.min(firstColumn, column);
    lastColumn = Math.max(lastColumn, column);
  }
  return firstLine === Infinity ? undefined : { firstLine, lastLine, firstColumn, lastColumn };
};

/** The cell under the focus, when no range is painted. */
export const focusedCell = (
  root: HTMLElement,
  context: GridFeatureContext,
): Readonly<{ line: number; column: number }> | undefined => {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return undefined;
  const cell = active.closest<HTMLElement>("[data-grid-cell]");
  if (cell === null || cell.closest(GRID_ROOT) !== root) return undefined;
  const line = Number(cell.dataset.row);
  const column = context.columns.findIndex((candidate) => candidate.key === cell.dataset.col);
  return Number.isInteger(line) && column >= 0 ? { line, column } : undefined;
};

/** Whether a key or clipboard event belongs to the grid itself, not to a control inside a cell. */
export const gridOwnsEvent = (event: Event, root: HTMLElement): boolean => {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  return (
    target.closest("[data-grid-cell]") === target &&
    target.closest(GRID_ROOT) === root &&
    !isInteractiveGridTarget(target, root)
  );
};

/**
 * What one cell of the loaded page may become: its editor and stored value, or why it is not
 * editable (the same conditions the cell's own inline editor checks).
 */
export const targetOf = (
  context: GridFeatureContext,
  line: number,
  columnIndex: number,
): BatchTarget | string => {
  const shown = context.lines[line];
  const column = context.columns[columnIndex];
  if (shown?.kind !== "row" || column === undefined) return "That cell is not on the loaded page.";
  const row = shown.row;
  const field = context.features.inlineEdit?.fields.find((candidate) =>
    same(candidate.field, column.key),
  );
  if (field === undefined) return `${column.label} cannot be edited here.`;
  const storedKey =
    row.edit === undefined ? undefined : Object.keys(row.edit).find((key) => same(key, column.key));
  if (
    row.revision === undefined ||
    row.capabilities === undefined ||
    !row.capabilities.actions.includes("update") ||
    !row.capabilities.changeableFieldIds.some((fieldId) => same(fieldId, column.key)) ||
    storedKey === undefined ||
    row.edit === undefined
  )
    return `${column.label} is read-only on this record.`;
  return {
    line,
    row: row as DisplayRow & Readonly<{ revision: number }>,
    column,
    editor: field.editor,
    stored: row.edit[storedKey],
  };
};

/** Groups cell changes into the rows of one batch, refusing a batch past the limits. */
export const batchRowsOf = (
  changes: readonly Readonly<{ target: BatchTarget; cell: JsonValue }>[],
  visibleColumns: number,
): BatchRows | string => {
  const rows = new Map<
    string,
    { recordId: string; revision: number; values: Record<string, JsonValue> }
  >();
  for (const { target, cell } of changes) {
    const held = rows.get(target.row.recordId) ?? {
      recordId: target.row.recordId,
      revision: target.row.revision,
      values: {},
    };
    held.values[target.column.key] = cell;
    rows.set(target.row.recordId, held);
  }
  const fieldLimit = Math.min(recordsTableBatchEditMaximumFields, visibleColumns);
  if (rows.size > recordsTableBatchEditMaximumRows)
    return `A batch changes at most ${recordsTableBatchEditMaximumRows} records. Select fewer rows.`;
  for (const row of rows.values())
    if (Object.keys(row.values).length > fieldLimit)
      return `A batch changes at most ${fieldLimit} fields of a record.`;
  // The identities are the ones the server projected for the shown rows; the server checks them again.
  return [...rows.values()] as unknown as BatchRows;
};

/** How a record is named in a sentence: its first column's text when it has one, else its row. */
const recordName = (context: GridFeatureContext, line: number): string => {
  const shown = line < 0 ? undefined : context.lines[line];
  if (shown?.kind !== "row") return "A record that is not on this page";
  const first = context.columns[0];
  const cell = first === undefined ? undefined : shown.row.cells[first.key];
  return cell?.kind === "text" && cell.text.trim().length > 0
    ? `${cell.text.trim()} (row ${line + 1})`
    : `Row ${line + 1}`;
};

const invalidClasses = ["ring-2", "ring-inset", "ring-destructive"];

/**
 * The one request a batch is and the notice that tells its outcome. A paste or fill posts the rows
 * and, on a refusal, marks every offending cell (aria-invalid, a ring and a sentence beside the grid; the
 * sentence is what carries the meaning) and writes nothing locally; on success it asks the page for
 * its one bounded refresh.
 */
export function useBatchEdit(
  context: GridFeatureContext,
  surface: GridInteractionSurface,
): Readonly<{
  busy: boolean;
  run: (
    action: RecordsTableBatchEditRequest["operation"],
    rows?: BatchRows,
  ) => Promise<DisplayBatchEditAnswer | undefined>;
  refuse: (title: string, problems: readonly BatchProblem[]) => void;
  tell: (title: string) => void;
  notice: ReactElement | null;
}> {
  const handler = context.events?.batch_edit_requested;
  const refresh = context.events?.refresh;
  const sharedState = useContext(FlowRuntimeStateContext);
  const standaloneState = useRef<ReturnType<typeof createFlowRuntimeState> | undefined>(undefined);
  if (sharedState === undefined) standaloneState.current ??= createFlowRuntimeState();
  const state = sharedState ?? standaloneState.current!;
  const messageTarget = `grid-batch:${useId()}`;
  const notice = useSyncExternalStore(
    (listener) =>
      state.subscribe(`message:${state.messages.key("inline", messageTarget)}`, listener),
    () => state.messages.read("inline", messageTarget),
    () => undefined,
  );
  const clearMessage = useCallback(
    () => state.messages.clear("inline", messageTarget),
    [state, messageTarget],
  );
  useEffect(() => () => clearMessage(), [clearMessage]);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const latest = useRef(context);
  latest.current = context;
  const headingId = useId();

  const refuse = useCallback(
    (title: string, problems: readonly BatchProblem[]): void => {
      state.messages.show({
        id: crypto.randomUUID(),
        target: "inline",
        component: messageTarget,
        severity: "error",
        text: title,
        details: problems.map(
          (problem) =>
            `${recordName(latest.current, problem.line)}${
              problem.field === undefined
                ? ""
                : `, ${latest.current.columns.find((column) => same(column.key, problem.field!))?.label ?? problem.field}`
            }: ${problem.message}`,
        ),
        locations: problems.map((problem) => ({ row: problem.line, field: problem.field })),
      });
    },
    [state, messageTarget],
  );
  const tell = useCallback(
    (title: string): void =>
      state.messages.show({
        id: crypto.randomUUID(),
        target: "inline",
        component: messageTarget,
        severity: "success",
        text: title,
      }),
    [state, messageTarget],
  );

  const run = useCallback(
    async (
      action: RecordsTableBatchEditRequest["operation"],
      rows?: BatchRows,
    ): Promise<DisplayBatchEditAnswer | undefined> => {
      if (handler === undefined || working.current) return undefined;
      working.current = true;
      setBusy(true);
      clearMessage();
      try {
        const answer = (await handler({
          event: "batch_edit_requested",
          action,
          ...(rows === undefined ? {} : { rows }),
        })) as DisplayBatchEditAnswer | undefined;
        const parsed = recordsTableBatchEditResultSchema.safeParse(answer?.result);
        if (!parsed.success || answer === undefined) {
          console.error(
            "[grid] invalid batch edit response",
            parsed.success ? "missing answer" : parsed.error,
          );
          refuse("Nothing was changed. That is not available right now.", []);
          return undefined;
        }
        const result = parsed.data;
        if (result.kind === "saved") {
          refresh?.({ event: "refresh" });
          return answer;
        }
        if (result.kind === "cells_refused") {
          const lineOf = (recordId: string): number =>
            latest.current.lines.findIndex(
              (line) => line.kind === "row" && same(line.row.recordId, recordId),
            );
          refuse(
            "Nothing was changed. These cells stopped the change:",
            result.problems.map((problem: RecordsTableBatchEditProblem) => ({
              line: lineOf(problem.recordId),
              recordId: problem.recordId,
              field: problem.field,
              message: problem.message,
            })),
          );
          return answer;
        }
        if (result.kind === "unknown")
          refuse("The outcome is not known. Retry it, or reload the page to see what changed.", []);
        else refuse("Nothing was changed. That is not available right now.", []);
        return answer;
      } catch (error) {
        console.error("[grid] a batch edit could not be sent", error);
        refuse("Nothing was changed. That is not available right now.", []);
        return undefined;
      } finally {
        working.current = false;
        setBusy(false);
      }
    },
    [handler, refresh, refuse, clearMessage],
  );

  // The refused cells wear aria-invalid and a ring until the notice goes; the ring is never the
  // only sign, the sentence in the notice names each cell.
  const marked = notice?.locations;
  useEffect(() => {
    const root = surface.rootRef.current;
    if (root === null || marked === undefined || marked.length === 0) return;
    const keys = latest.current.columns.map((column) => column.key);
    const cells: HTMLElement[] = [];
    for (const problem of marked) {
      if (problem.row < 0) continue;
      const selector =
        problem.field === undefined
          ? `[data-grid-cell][data-row="${problem.row}"]`
          : `[data-grid-cell][data-row="${problem.row}"][data-col="${CSS.escape(
              keys.find((key) => same(key, problem.field!)) ?? problem.field,
            )}"]`;
      for (const cell of root.querySelectorAll<HTMLElement>(selector))
        if (cell.closest(GRID_ROOT) === root) cells.push(cell);
    }
    for (const cell of cells) {
      cell.setAttribute("aria-invalid", "true");
      cell.classList.add(...invalidClasses);
    }
    return () => {
      for (const cell of cells) {
        cell.removeAttribute("aria-invalid");
        cell.classList.remove(...invalidClasses);
      }
    };
  }, [marked, surface.rootRef]);

  // A new page or query forgets the notice: its cells are not the ones that were refused.
  useEffect(() => {
    if (state.messages.read("inline", messageTarget)?.severity === "error") clearMessage();
  }, [context.rows, state, messageTarget, clearMessage]);

  const element =
    notice === undefined ? null : (
      <Alert
        variant={notice.severity === "error" ? "destructive" : "success"}
        role={notice.severity === "error" ? "alert" : "status"}
        aria-live={notice.severity === "error" ? "assertive" : "polite"}
        aria-labelledby={headingId}
        className="max-w-prose"
      >
        <AlertTitle id={headingId}>{notice.text}</AlertTitle>
        {notice.details === undefined || notice.details.length === 0 ? null : (
          <AlertDescription>
            <ul className="list-disc pl-4">
              {notice.details.slice(0, 20).map((line) => (
                <li key={line}>{line}</li>
              ))}
              {notice.details.length > 20 ? (
                <li>and {notice.details.length - 20} more cells</li>
              ) : null}
            </ul>
          </AlertDescription>
        )}
        <Button type="button" variant="outline" size="xs" onClick={clearMessage}>
          Dismiss
        </Button>
      </Alert>
    );

  return { busy, run, refuse, tell, notice: element };
}
