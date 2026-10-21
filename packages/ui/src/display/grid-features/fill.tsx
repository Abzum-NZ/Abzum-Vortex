"use client";

import { useEffect, useRef, type ReactElement } from "react";
import type { JsonValue } from "@vortex/platform/schema";
import {
  batchRowsOf,
  gridOwnsEvent,
  paintedRange,
  targetOf,
  useBatchEdit,
  type BatchProblem,
  type BatchTarget,
} from "./batch-edit-client";
import { sameEditValue } from "./edit-values";
import type { GridFeatureInteractionProps } from "./registry";

/**
 * Fill down: Ctrl+D copies the top row of the selected range into the rows beneath it, column by
 * column, as the stored values the server sent for the top row (never what the cells display). The
 * fill is ONE request that commits every cell or none; a read-only or withheld cell in the range
 * stops it with the cell named. Rows already holding the value are left out of the request.
 */
export default function Fill({ context, surface }: GridFeatureInteractionProps): ReactElement {
  const batch = useBatchEdit(context, surface);
  const latest = useRef({ context, batch });
  latest.current = { context, batch };

  useEffect(() => {
    const root = surface.rootRef.current;
    if (root === null) return;
    const keydown = (event: KeyboardEvent): void => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey ||
        event.isComposing ||
        event.key.toLowerCase() !== "d" ||
        !gridOwnsEvent(event, root)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const { context: now, batch: current } = latest.current;
      const range = paintedRange(root, now);
      if (range === undefined || range.firstLine === range.lastLine) {
        current.refuse(
          "Nothing was changed. Select the top cell and the cells below it to fill.",
          [],
        );
        return;
      }
      const problems: BatchProblem[] = [];
      const changes: Array<{ target: BatchTarget; cell: JsonValue }> = [];
      for (let column = range.firstColumn; column <= range.lastColumn; column += 1) {
        const top = targetOf(now, range.firstLine, column);
        const topRow = now.lines[range.firstLine];
        if (typeof top === "string") {
          problems.push({
            line: range.firstLine,
            recordId: topRow?.kind === "row" ? topRow.row.recordId : "",
            field: now.columns[column]?.key,
            message: top,
          });
          continue;
        }
        for (let line = range.firstLine + 1; line <= range.lastLine; line += 1) {
          const shown = now.lines[line];
          if (shown?.kind !== "row") continue;
          const target = targetOf(now, line, column);
          if (typeof target === "string") {
            problems.push({
              line,
              recordId: shown.row.recordId,
              field: top.column.key,
              message: target,
            });
            continue;
          }
          if (top.stored === undefined || sameEditValue(target.editor, target.stored, top.stored))
            continue;
          changes.push({ target, cell: top.stored });
        }
      }
      if (problems.length > 0) {
        current.refuse("Nothing was changed. These cells cannot be filled:", problems);
        return;
      }
      if (changes.length === 0) {
        current.tell("Nothing to change: the cells already hold the top value.");
        return;
      }
      const rows = batchRowsOf(changes, now.columns.length);
      if (typeof rows === "string") {
        current.refuse(rows, []);
        return;
      }
      void current.run("commit", rows).then((answer) => {
        if (answer?.result?.kind === "saved")
          current.tell(`Filled ${rows.length} ${rows.length === 1 ? "record" : "records"}.`);
      });
    };
    root.addEventListener("keydown", keydown, true);
    return () => root.removeEventListener("keydown", keydown, true);
  }, [surface.rootRef]);

  return (
    <div className="sticky left-0 flex flex-col gap-2 px-2" aria-busy={batch.busy || undefined}>
      {batch.notice}
    </div>
  );
}
