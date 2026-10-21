import { useCallback, useMemo, useRef } from "react";
import {
  recordsTableBatchEditResultSchema,
  type RecordsTableBatchEditRequest,
  type RecordsTableBatchEditResult,
} from "@vortex/platform/schema";
import type { DisplayBatchEditAnswer, DisplaySemanticEvent } from "@vortex/ui";
import type { ApplicationPageModel } from "../../../../../../_lib/application-page";
import { recordsTableAddress } from "./records-table-address";

type Rows = RecordsTableBatchEditRequest["rows"];
type Saved = Extract<RecordsTableBatchEditResult, { kind: "saved" }>;

/** The batches one placement can undo (most recent last) and redo, each as the rows that revert it. */
type Stacks = { undo: Rows[]; redo: Rows[] };

/** The rows that put back what a saved batch replaced, at the revisions the batch left behind. */
const inverseOf = (saved: Saved): Rows =>
  saved.rows.map((row) => ({
    recordId: row.recordId,
    revision: row.revision,
    values: row.previous,
  })) as Rows;

/**
 * Moves every stacked revert that expects a record at the revision this person's own write just
 * replaced onto the revision that write left. A revert whose record someone else changed keeps its
 * old revision, so the server refuses it and nothing is overwritten silently.
 */
const rebase = (stacks: Stacks, replaced: Rows, saved: Saved): void => {
  const moved = new Map(
    replaced.flatMap((row) => {
      const after = saved.rows.find((candidate) => candidate.recordId === row.recordId);
      return after === undefined
        ? []
        : [[`${row.recordId}:${row.revision}`, after.revision] as const];
    }),
  );
  for (const rows of [...stacks.undo, ...stacks.redo])
    rows.forEach((row, index) => {
      const next = moved.get(`${row.recordId}:${row.revision}`);
      if (next !== undefined) (rows as Array<Rows[number]>)[index] = { ...row, revision: next };
    });
};

/**
 * Paste, Fill and Undo of a Records table: one request per batch to the server, which validates
 * every cell and commits all of the batch or none of it, and the session-local stack of the batches
 * committed here. Undo and redo send the inverse batch with the revisions the batches left, so a
 * record changed since by anyone else refuses it. The stack lives in this page's memory only and is
 * forgotten when the person navigates or changes the query.
 */
export function useBatchUndo({
  model,
  navigationKey,
}: Readonly<{ model: ApplicationPageModel; navigationKey: string }>) {
  const held = useRef<{ scope: string; stacks: Map<string, Stacks> }>({
    scope: "",
    stacks: new Map(),
  });
  const stacksOf = useCallback(
    (placementId: string): Stacks => {
      const scope = `${navigationKey}|${window.location.search}`;
      if (held.current.scope !== scope) held.current = { scope, stacks: new Map() };
      let stacks = held.current.stacks.get(placementId);
      if (stacks === undefined) {
        stacks = { undo: [], redo: [] };
        held.current.stacks.set(placementId, stacks);
      }
      return stacks;
    },
    [navigationKey],
  );

  const post = useCallback(
    async (placementId: string, rows: Rows): Promise<RecordsTableBatchEditResult> => {
      try {
        const response = await fetch("/api/records-table/batch-edit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          cache: "no-store",
          body: JSON.stringify({
            ...recordsTableAddress(model),
            placementId,
            commandId: crypto.randomUUID(),
            rows,
          }),
        });
        const parsed = recordsTableBatchEditResultSchema.safeParse(await response.json());
        return parsed.success ? parsed.data : { kind: "unavailable" };
      } catch (error) {
        console.error("[grid] the batch edit request failed", error);
        return { kind: "unavailable" };
      }
    },
    [model],
  );

  const eventsFor = useCallback(
    (placementId: string) => ({
      batch_edit_requested: async (
        event: DisplaySemanticEvent,
      ): Promise<DisplayBatchEditAnswer | undefined> => {
        if (event.event !== "batch_edit_requested") return undefined;
        const stacks = stacksOf(placementId);
        const depths = (
          result: RecordsTableBatchEditResult | undefined,
        ): DisplayBatchEditAnswer => ({
          result,
          undoDepth: stacks.undo.length,
          redoDepth: stacks.redo.length,
        });
        if (event.action === "state") return depths(undefined);
        if (event.action === "commit") {
          if (event.rows === undefined) return undefined;
          const result = await post(placementId, event.rows);
          if (result.kind === "saved") {
            rebase(stacks, event.rows, result);
            stacks.undo.push(inverseOf(result));
            stacks.redo = [];
          }
          return depths(result);
        }
        const from = event.action === "undo" ? stacks.undo : stacks.redo;
        const to = event.action === "undo" ? stacks.redo : stacks.undo;
        const rows = from.pop();
        if (rows === undefined) return depths(undefined);
        const result = await post(placementId, rows);
        if (result.kind === "saved") {
          rebase(stacks, rows, result);
          to.push(inverseOf(result));
        } else from.push(rows);
        return depths(result);
      },
    }),
    [post, stacksOf],
  );
  return useMemo(() => ({ eventsFor }), [eventsFor]);
}
