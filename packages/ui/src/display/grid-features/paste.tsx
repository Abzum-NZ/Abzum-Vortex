"use client";

import { useEffect, useRef, type ReactElement } from "react";
import type { JsonValue } from "@vortex/platform/schema";
import { toLocalInputValue } from "../../controls/date-time-zone";
import { useDateFormatOptions } from "../date-format-context";
import {
  batchRowsOf,
  focusedCell,
  gridOwnsEvent,
  paintedRange,
  targetOf,
  useBatchEdit,
  type BatchProblem,
  type BatchTarget,
} from "./batch-edit-client";
import { readEditDraft, sameEditValue, type EditDraft } from "./edit-values";
import type { GridFeatureInteractionProps } from "./registry";

/** Reads tab-separated text as spreadsheets write it: quoted fields may hold tabs, quotes and breaks. */
const parseTsv = (text: string): readonly (readonly string[])[] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;
  const endField = (): void => {
    row.push(field);
    field = "";
    started = false;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += char;
    } else if (char === '"' && !started) {
      quoted = true;
      started = true;
    } else if (char === "\t") endField();
    else if (char === "\r" && text[index + 1] === "\n") {
      endRow();
      index += 1;
    } else if (char === "\n" || char === "\r") endRow();
    else {
      field += char;
      started = true;
    }
  }
  // A trailing line break ends the last row; it does not start an empty one.
  if (field !== "" || started || row.length > 0) endRow();
  return rows;
};

const truthy = new Set(["true", "yes", "y", "1", "on", "checked"]);
const falsy = new Set(["false", "no", "n", "0", "off", "unchecked", ""]);
const INSTANT = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/;

/** One pasted text as the cell it becomes, or the sentence why it cannot be. */
const cellOf = (
  target: BatchTarget,
  text: string,
  zone: string,
):
  | Readonly<{ ok: true; cell: JsonValue | undefined }>
  | Readonly<{ ok: false; message: string }> => {
  const { editor, column } = target;
  // A record's title is not a value the writer takes: links cannot be pasted yet.
  if (editor.kind === "link") return { ok: false, message: "Links can't be pasted yet." };
  let draft: EditDraft = text;
  if (editor.kind === "yes_no") {
    const word = text.trim().toLowerCase();
    if (!truthy.has(word) && !falsy.has(word))
      return { ok: false, message: `${column.label} must be yes or no.` };
    draft = truthy.has(word);
  } else if (editor.kind === "choice") {
    const word = text.trim().toLowerCase();
    // A copied cell holds the option's label; a typed value may be the option's own value.
    draft =
      editor.options.find(
        (option) => option.label.toLowerCase() === word || option.value.toLowerCase() === word,
      )?.value ?? text;
  } else if (editor.kind === "date_time" && INSTANT.test(text.trim())) {
    draft = toLocalInputValue(text.trim(), zone);
  }
  const reading = readEditDraft(editor, draft, column.label, zone);
  if (!reading.ok) return reading;
  // A value the record already holds is not a change.
  if (sameEditValue(editor, target.stored, reading.value)) return { ok: true, cell: undefined };
  return { ok: true, cell: reading.value };
};

/**
 * Paste: Ctrl+V of tab-separated text over the loaded page, starting at the top-left of the selected
 * range (or the focused cell). The text is read with the one edit-value reader into the value each
 * field's inline editor would submit; a link cell stops the paste (links cannot be pasted yet).
 * The whole paste is ONE request that commits every cell or none: a cell that is not on the page,
 * is read-only or cannot be read stops it, with every offending cell named before anything is sent.
 * One value pasted over a larger selection fills the selection.
 */
export default function Paste({ context, surface }: GridFeatureInteractionProps): ReactElement {
  const batch = useBatchEdit(context, surface);
  const { timeZone } = useDateFormatOptions();
  const zone = timeZone ?? "UTC";
  const latest = useRef({ context, batch, zone });
  latest.current = { context, batch, zone };

  useEffect(() => {
    const root = surface.rootRef.current;
    if (root === null) return;
    const paste = (event: ClipboardEvent): void => {
      if (!gridOwnsEvent(event, root) || event.clipboardData === null) return;
      const { context: now, batch: current, zone: timeZoneNow } = latest.current;
      const text = event.clipboardData.getData("text/plain");
      if (text.length === 0) return;
      event.preventDefault();
      const range = paintedRange(root, now);
      const origin = range
        ? { line: range.firstLine, column: range.firstColumn }
        : focusedCell(root, now);
      if (origin === undefined) return;
      const grid = parseTsv(text);
      if (grid.length === 0) return;
      const width = Math.max(...grid.map((row) => row.length));
      const single = grid.length === 1 && width === 1;
      // One value over a larger selection fills it; anything else pastes its own size.
      const lines = single && range ? range.lastLine - range.firstLine + 1 : grid.length;
      const columns = single && range ? range.lastColumn - range.firstColumn + 1 : width;
      const problems: BatchProblem[] = [];
      const changes: Array<{ target: BatchTarget; cell: JsonValue }> = [];
      const rowLines: number[] = [];
      for (let line = origin.line; rowLines.length < lines && line < now.lines.length; line += 1)
        if (now.lines[line]?.kind === "row") rowLines.push(line);
      if (rowLines.length < lines) {
        current.refuse("Nothing was changed. The paste is longer than the loaded page.", []);
        return;
      }
      if (origin.column + columns > now.columns.length) {
        current.refuse("Nothing was changed. The paste is wider than the visible columns.", []);
        return;
      }
      rowLines.forEach((line, rowIndex) => {
        for (let offset = 0; offset < columns; offset += 1) {
          const pasted = single ? grid[0]![0]! : (grid[rowIndex]?.[offset] ?? "");
          const target = targetOf(now, line, origin.column + offset);
          const recordId = now.lines[line]?.kind === "row" ? now.lines[line].row.recordId : "";
          if (typeof target === "string") {
            problems.push({
              line,
              recordId,
              field: now.columns[origin.column + offset]?.key,
              message: target,
            });
            continue;
          }
          const made = cellOf(target, pasted, timeZoneNow);
          if (!made.ok)
            problems.push({ line, recordId, field: target.column.key, message: made.message });
          else if (made.cell !== undefined) changes.push({ target, cell: made.cell });
        }
      });
      if (problems.length > 0) {
        current.refuse("Nothing was changed. These cells cannot take the pasted values:", problems);
        return;
      }
      if (changes.length === 0) {
        current.tell("Nothing to change: the pasted values are already there.");
        return;
      }
      const rows = batchRowsOf(changes, now.columns.length);
      if (typeof rows === "string") {
        current.refuse(rows, []);
        return;
      }
      void current.run("commit", rows).then((answer) => {
        if (answer?.result?.kind === "saved")
          current.tell(`Pasted into ${rows.length} ${rows.length === 1 ? "record" : "records"}.`);
      });
    };
    root.addEventListener("paste", paste);
    return () => root.removeEventListener("paste", paste);
  }, [surface.rootRef]);

  return (
    <div className="sticky left-0 flex flex-col gap-2 px-2" aria-busy={batch.busy || undefined}>
      {batch.notice}
    </div>
  );
}
