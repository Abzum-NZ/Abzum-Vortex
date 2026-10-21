"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from "react";
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

export type BatchRows = RecordsTableBatchEditRequest["rows"];

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

type Notice = Readonly<{
  tone: "info" | "success" | "critical";
  title: string;
  lines: readonly string[];
  problems: readonly BatchProblem[];
}>;

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
 * The one request a batch is and the notice that tells its outcome. `commit` posts the rows and, on
 * a refusal, marks every offending cell (aria-invalid, a ring and a sentence beside the grid; the
 * sentence is what carries the meaning) and writes nothing locally; on success it asks the page for
 * its one bounded refresh.
 */
export function useBatchEdit(
  context: GridFeatureContext,
  surface: GridInteractionSurface,
): Readonly<{
  busy: boolean;
  run: (
    action: "commit" | "undo" | "redo",
    rows?: BatchRows,
  ) => Promise<DisplayBatchEditAnswer | undefined>;
  refuse: (title: string, problems: readonly BatchProblem[]) => void;
  tell: (title: string) => void;
  notice: ReactElement | null;
}> {
  const handler = context.events?.batch_edit_requested;
  const refresh = context.events?.refresh;
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const latest = useRef(context);
  latest.current = context;
  const headingId = useId();

  const refuse = useCallback((title: string, problems: readonly BatchProblem[]): void => {
    setNotice({
      tone: "critical",
      title,
      lines: problems.map(
        (problem) =>
          `${recordName(latest.current, problem.line)}${
            problem.field === undefined
              ? ""
              : `, ${latest.current.columns.find((column) => same(column.key, problem.field!))?.label ?? problem.field}`
          }: ${problem.message}`,
      ),
      problems,
    });
  }, []);
  const tell = useCallback(
    (title: string): void => setNotice({ tone: "success", title, lines: [], problems: [] }),
    [],
  );

  const run = useCallback(
    async (
      action: "commit" | "undo" | "redo",
      rows?: BatchRows,
    ): Promise<DisplayBatchEditAnswer | undefined> => {
      if (handler === undefined || working.current) return undefined;
      working.current = true;
      setBusy(true);
      setNotice(undefined);
      try {
        const answer = (await handler({
          event: "batch_edit_requested",
          action,
          ...(rows === undefined ? {} : { rows }),
        })) as DisplayBatchEditAnswer | undefined;
        const parsed = recordsTableBatchEditResultSchema.safeParse(answer?.result);
        if (!parsed.success || answer === undefined) {
          setNotice({
            tone: "critical",
            title: "Nothing was changed. That is not available right now.",
            lines: [],
            problems: [],
          });
          return undefined;
        }
        const result = parsed.data;
        if (result.kind === "saved") {
          refresh?.({ event: "refresh" });
          return answer;
        }
        if (result.kind === "refused") {
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
        setNotice({
          tone: "critical",
          title: "Nothing was changed. That is not available right now.",
          lines: [],
          problems: [],
        });
        return answer;
      } catch (error) {
        console.error("[grid] a batch edit could not be sent", error);
        setNotice({
          tone: "critical",
          title: "Nothing was changed. That is not available right now.",
          lines: [],
          problems: [],
        });
        return undefined;
      } finally {
        working.current = false;
        setBusy(false);
      }
    },
    [handler, refresh, refuse],
  );

  // The refused cells wear aria-invalid and a ring until the notice goes; the ring is never the
  // only sign, the sentence in the notice names each cell.
  const marked = notice?.problems;
  useEffect(() => {
    const root = surface.rootRef.current;
    if (root === null || marked === undefined || marked.length === 0) return;
    const keys = latest.current.columns.map((column) => column.key);
    const cells: HTMLElement[] = [];
    for (const problem of marked) {
      if (problem.line < 0) continue;
      const selector =
        problem.field === undefined
          ? `[data-grid-cell][data-row="${problem.line}"]`
          : `[data-grid-cell][data-row="${problem.line}"][data-col="${CSS.escape(
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
    setNotice((held) => (held?.tone === "critical" ? undefined : held));
  }, [context.rows]);

  const element =
    notice === undefined ? null : (
      <Alert
        variant={notice.tone === "critical" ? "critical" : "success"}
        role={notice.tone === "critical" ? "alert" : "status"}
        aria-labelledby={headingId}
        className="max-w-prose"
      >
        <AlertTitle id={headingId}>{notice.title}</AlertTitle>
        {notice.lines.length === 0 ? null : (
          <AlertDescription>
            <ul className="list-disc pl-4">
              {notice.lines.slice(0, 20).map((line) => (
                <li key={line}>{line}</li>
              ))}
              {notice.lines.length > 20 ? <li>and {notice.lines.length - 20} more cells</li> : null}
            </ul>
          </AlertDescription>
        )}
        <Button type="button" variant="outline" size="xs" onClick={() => setNotice(undefined)}>
          Dismiss
        </Button>
      </Alert>
    );

  return { busy, run, refuse, tell, notice: element };
}
