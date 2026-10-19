"use client";

import { useState, type ReactElement } from "react";
import { Checkbox } from "../../components/checkbox";
import { Input } from "../../components/input";
import type { DisplayCellValue, DisplayEventHandler } from "../projected-data";
import type { GridFeatureCellProps, GridFeatureModule } from "./registry";

/**
 * One in-place editor for a declared permitted field. It commits the edited value as the table's
 * declared `inline_edit` event carrying the stable identity of the commit binding, the record, the
 * record revision the row was read at, the field and the new closed value. The revision lets the
 * server refuse a change made against a stale row; a row whose payload carries no revision sends
 * none and the server still re-checks the change.
 */
function InlineEditCell({
  eventId,
  recordId,
  revision,
  field,
  label,
  value,
  handler,
}: Readonly<{
  eventId: string;
  recordId: string;
  revision?: number;
  field: string;
  label: string;
  value: DisplayCellValue;
  handler: DisplayEventHandler;
}>): ReactElement {
  const [text, setText] = useState(() =>
    value.kind === "number" ? String(value.value) : value.kind === "text" ? value.text : "",
  );
  const [checked, setChecked] = useState(value.kind === "boolean" ? value.value : false);
  const revisionField = revision === undefined ? {} : { revision };
  // Commits only a real change of a text or number cell; leaving the editor unchanged, or with a
  // value that is not a number, sends nothing.
  const commitText = (): void => {
    if (value.kind === "number") {
      const parsed = Number(text);
      if (!Number.isFinite(parsed) || text.trim().length === 0 || parsed === value.value) return;
      handler({
        event: "inline_edit",
        eventId,
        recordId,
        ...revisionField,
        field,
        value: { kind: "number", value: parsed },
      });
      return;
    }
    if (value.kind !== "text" || text === value.text) return;
    handler({
      event: "inline_edit",
      eventId,
      recordId,
      ...revisionField,
      field,
      value: { kind: "text", text },
    });
  };
  if (value.kind === "boolean")
    return (
      <Checkbox
        aria-label={`Edit ${label}`}
        checked={checked}
        onClick={(event) => event.stopPropagation()}
        onCheckedChange={(next) => {
          setChecked(next);
          handler({
            event: "inline_edit",
            eventId,
            recordId,
            ...revisionField,
            field,
            value: { kind: "boolean", value: next },
          });
        }}
      />
    );
  return (
    <Input
      type={value.kind === "number" ? "number" : "text"}
      aria-label={`Edit ${label}`}
      value={text}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => setText(event.currentTarget.value)}
      onBlur={commitText}
      onKeyDown={(event) => {
        // Escape reaches the grid, which returns focus from the editor to its cell.
        if (event.key !== "Escape") event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          commitText();
        }
      }}
    />
  );
}

/**
 * Inline editing: a cell becomes its editor only for a field the projection lets this viewer edit,
 * on a row whose own capabilities allow updating that field, and only for a text, link, number or
 * yes/no value the editor can commit without guessing. Every other cell keeps its plain value. The
 * row revision travels with the commit so the server refuses a stale change.
 */
function InlineEditor({ context, row, column, children }: GridFeatureCellProps): ReactElement {
  const inlineEdit = context.features.inlineEdit;
  const onInlineEdit = context.events?.inline_edit;
  const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
  const cell: DisplayCellValue = row.cells[column.key] ?? { kind: "empty" };
  const editable =
    inlineEdit !== undefined &&
    onInlineEdit !== undefined &&
    inlineEdit.fields.some((field) => same(field, column.key)) &&
    row.capabilities !== undefined &&
    row.capabilities.actions.includes("update") &&
    row.capabilities.changeableFieldIds.some((fieldId) => same(fieldId, column.key)) &&
    (cell.kind === "text" ||
      cell.kind === "link" ||
      cell.kind === "number" ||
      cell.kind === "boolean");
  if (!editable || inlineEdit === undefined || onInlineEdit === undefined) return <>{children}</>;
  return (
    // Keyed by the projected value so a refreshed row resets the editor.
    <InlineEditCell
      key={JSON.stringify(cell)}
      eventId={inlineEdit.eventId}
      recordId={row.recordId}
      {...(row.revision === undefined ? {} : { revision: row.revision })}
      field={column.key}
      label={column.label}
      value={cell.kind === "link" ? { kind: "text", text: cell.label } : cell}
      handler={onInlineEdit}
    />
  );
}

export const gridFeature: GridFeatureModule = { CellEditor: InlineEditor };
