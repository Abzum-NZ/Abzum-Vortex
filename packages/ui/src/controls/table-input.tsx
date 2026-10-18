"use client";

import type { ReactElement } from "react";
import {
  builderKeySchema,
  normalizeExactDecimal,
  sourceModuleFieldValueSchemas,
} from "@vortex/platform/schema";
import { Button } from "../components/button";
import { Card } from "../components/card";
import { Field, FieldLabel } from "../components/field";
import { Input } from "../components/input";
import { NativeSelect, NativeSelectOption } from "../components/native-select";
import { DefinitionRenderError } from "../definition-error";
import {
  readControlSettings,
  resolveControlContext,
  type ControlRenderProps,
} from "./control-context";
import {
  describedBy,
  FieldLabelText,
  FieldMessages,
  inactiveNote,
  useFieldFeedback,
  useFieldIds,
  useSeededState,
} from "./field-parts";
import { useFormField, useFormFieldError } from "./form-context";
import type { TableInputPayload, TypedTableValue } from "./projected-data";

const EMPTY_ROWS: TypedTableValue = [];
const TYPES = [
  "text",
  "whole_number",
  "decimal_number",
  "money",
  "yes_no",
  "date",
  "date_time",
  "choice",
] as const;
type ColumnType = (typeof TYPES)[number];
type Column = Readonly<{
  key: string;
  type: ColumnType;
  required: boolean;
  currency?: string;
  options: readonly Readonly<{ key: string; label: string }>[];
}>;
type Row = TypedTableValue[number];

/** One Puck control for the table field's declared columns; the record writer owns final policy. */
export function TableInput(props: ControlRenderProps<TableInputPayload>): ReactElement {
  const context = resolveControlContext(props, ["field_changed"]);
  const settings = readControlSettings(props, context.location);
  const fail = (message: string): never => {
    throw new DefinitionRenderError("INVALID_COMPOSITION", message, context.location);
  };
  const columns: Column[] = settings.groups("columns").map((group) => {
    const key = group.key;
    const type = group.type;
    const required = group.required;
    if (
      key?.kind !== "text" ||
      !builderKeySchema.safeParse(key.value).success ||
      type?.kind !== "choice" ||
      !(TYPES as readonly string[]).includes(type.value) ||
      required?.kind !== "boolean"
    )
      return fail("A table input column is invalid");
    const choices = group.options;
    if (type.value === "choice" && choices?.kind !== "list")
      return fail("A choice column requires its options");
    const options =
      choices?.kind === "list"
        ? choices.items.map((item) => {
            const values = item.kind === "group" ? item.properties : {};
            if (values.key?.kind !== "text" || values.label?.kind !== "text")
              return fail("A table choice option is invalid");
            return { key: values.key.value, label: values.label.value };
          })
        : [];
    return {
      key: key.value,
      type: type.value as ColumnType,
      required: required.value,
      options,
      ...(group.currency?.kind === "text" ? { currency: group.currency.value } : {}),
    };
  });
  const minimum = settings.number("minimum_rows");
  const maximum = settings.number("maximum_rows");
  if (
    minimum === undefined ||
    maximum === undefined ||
    minimum > maximum ||
    columns.length === 0 ||
    new Set(columns.map((column) => column.key)).size !== columns.length
  )
    fail("A table input requires columns and row limits");
  const ids = useFieldIds();
  const fieldKey = settings.fieldKey();
  const label = context.accessibleName ?? props.metadata.name;
  const required = settings.boolean("required");
  const readOnly = settings.boolean("read_only");
  const help = settings.text("help_text");
  const draftFeedback = useFieldFeedback(fieldKey);
  const disabled =
    context.inactive || settings.boolean("disabled") || draftFeedback?.disabled === true;
  const locked = disabled || readOnly;
  // A stable serialized seed prevents a rebuilt equal row array from discarding local edits.
  const [raw, setRaw] = useSeededState(JSON.stringify(context.values?.value ?? EMPTY_ROWS));
  const rows = JSON.parse(raw) as TypedTableValue;
  let invalid: string | undefined;
  const typed: TypedTableValue = rows.map((row, index) => {
    const result: Row = {};
    for (const column of columns) {
      const value = row[column.key];
      const missing = value === undefined || value === "";
      if (missing) {
        if (column.required)
          invalid ??= `Row ${index + 1}: ${column.key.replaceAll("_", " ")} is required.`;
        continue;
      }
      let candidate: unknown = value;
      if (column.type === "whole_number")
        candidate =
          typeof value === "number"
            ? value
            : /^-?\d+$/.test(String(value))
              ? Number(value)
              : undefined;
      if (column.type === "decimal_number") candidate = normalizeExactDecimal(String(value));
      if (column.type === "money" && typeof value === "object" && value !== null)
        candidate = {
          amount: normalizeExactDecimal(value.amount),
          currency: column.currency ?? value.currency,
        };
      const parsed = sourceModuleFieldValueSchemas[column.type].safeParse(candidate);
      if (
        !parsed.success ||
        (column.type === "choice" && !column.options.some((option) => option.key === candidate))
      ) {
        invalid ??= `Row ${index + 1}: enter a valid ${column.key.replaceAll("_", " ")}.`;
        continue;
      }
      result[column.key] = parsed.data;
    }
    return result;
  });
  const minimumRows = Math.max(minimum!, required ? 1 : 0);
  const localError =
    (required || rows.length > 0) && rows.length < minimumRows
      ? `${label} needs at least ${minimumRows} row${minimumRows === 1 ? "" : "s"}.`
      : rows.length > maximum!
        ? `${label} allows at most ${maximum} rows.`
        : invalid;
  useFormField(
    fieldKey,
    props.placementId,
    !required && typed.length === 0 ? null : typed,
    locked || localError === undefined ? undefined : () => localError,
  );
  const validationError = useFormFieldError(fieldKey);
  const error = context.values?.error ?? validationError;
  const note = inactiveNote(context);
  const change = (next: TypedTableValue): void => {
    if (locked) return;
    setRaw(JSON.stringify(next));
    // Incomplete rows remain in local state. The form refuses them on submit.
    if (sourceModuleFieldValueSchemas.table.safeParse(next).success)
      context.events?.field_changed?.({
        event: "field_changed",
        fieldKey,
        value: !required && next.length === 0 ? null : next,
      });
  };
  const cell = (index: number, column: Column, value: Row[string] | undefined): void => {
    change(
      rows.map((row, rowIndex) => {
        if (rowIndex !== index) return row;
        const next = { ...row };
        if (value === undefined) delete next[column.key];
        else next[column.key] = value;
        return next;
      }),
    );
  };
  return (
    <Field
      data-vortex-control="table-input"
      data-vortex-placement-id={props.placementId}
      data-vortex-field-key={fieldKey}
      hidden={draftFeedback?.hidden === true}
    >
      <FieldLabel id={ids.label}>
        <FieldLabelText label={label} required={required} />
      </FieldLabel>
      <div
        id={ids.control}
        role="group"
        aria-labelledby={ids.label}
        aria-invalid={error !== undefined}
        {...describedBy(ids, help, error, note, draftFeedback)}
        className="space-y-3"
      >
        {rows.map((row, index) => (
          <Card
            key={index}
            className="space-y-3 p-3"
            role="group"
            aria-label={`Row ${index + 1}`}
          >
            {columns.map((column) => {
              const value = row[column.key];
              const cellId = `${ids.control}-${index}-${column.key}`;
              const common = {
                id: cellId,
                "aria-label": `${column.key.replaceAll("_", " ")}, row ${index + 1}`,
                disabled: locked,
                required: column.required,
              };
              const money =
                typeof value === "object" && value !== null
                  ? value
                  : { amount: "", currency: column.currency ?? "" };
              return (
                <Field key={column.key}>
                  <FieldLabel htmlFor={cellId}>
                    <FieldLabelText
                      label={`${column.key.replaceAll("_", " ")}${column.type === "date_time" ? " (UTC)" : ""}`}
                      required={column.required}
                    />
                  </FieldLabel>
                  {column.type === "choice" || column.type === "yes_no" ? (
                    <NativeSelect
                      {...common}
                      value={value === undefined ? "" : String(value)}
                      onChange={(event) =>
                        cell(
                          index,
                          column,
                          event.target.value === ""
                            ? undefined
                            : column.type === "yes_no"
                              ? event.target.value === "true"
                              : event.target.value,
                        )
                      }
                    >
                      <NativeSelectOption value="">Choose…</NativeSelectOption>
                      {(column.type === "yes_no"
                        ? [
                            { key: "true", label: "Yes" },
                            { key: "false", label: "No" },
                          ]
                        : column.options
                      ).map((option) => (
                        <NativeSelectOption key={option.key} value={option.key}>
                          {option.label}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  ) : column.type === "money" ? (
                    <div className="flex gap-2">
                      <Input
                        {...common}
                        inputMode="decimal"
                        value={money.amount}
                        onChange={(event) =>
                          cell(
                            index,
                            column,
                            event.target.value === ""
                              ? undefined
                              : { amount: event.target.value, currency: money.currency },
                          )
                        }
                      />
                      {column.currency === undefined ? (
                        <Input
                          aria-label={`Currency for ${column.key}, row ${index + 1}`}
                          disabled={locked}
                          value={money.currency}
                          maxLength={3}
                          placeholder="Currency"
                          onChange={(event) =>
                            cell(index, column, {
                              amount: money.amount,
                              currency: event.target.value.toUpperCase(),
                            })
                          }
                        />
                      ) : (
                        <span>{column.currency}</span>
                      )}
                    </div>
                  ) : (
                    <Input
                      {...common}
                      type={
                        column.type === "date"
                          ? "date"
                          : column.type === "date_time"
                            ? "datetime-local"
                            : "text"
                      }
                      inputMode={
                        column.type === "whole_number"
                          ? "numeric"
                          : column.type === "decimal_number"
                            ? "decimal"
                            : undefined
                      }
                      step={column.type === "date_time" ? "any" : undefined}
                      value={
                        column.type === "date_time" && typeof value === "string"
                          ? new Date(value).toISOString().slice(0, -1)
                          : value === undefined
                            ? ""
                            : String(value)
                      }
                      onChange={(event) =>
                        cell(
                          index,
                          column,
                          event.target.value === ""
                            ? undefined
                            : column.type === "date_time"
                              ? `${event.target.value}${event.target.value.length === 16 ? ":00" : ""}Z`
                              : event.target.value,
                        )
                      }
                    />
                  )}
                </Field>
              );
            })}
            <Button
              type="button"
              variant="outline"
              disabled={locked}
              onClick={() => change(rows.filter((_, rowIndex) => rowIndex !== index))}
            >
              Remove row {index + 1}
            </Button>
          </Card>
        ))}
        <Button
          type="button"
          variant="outline"
          disabled={locked || rows.length >= maximum!}
          onClick={() => change([...rows, {}])}
        >
          Add row
        </Button>
      </div>
      <FieldMessages
        ids={ids}
        help={help}
        error={error}
        note={note}
        draftFeedback={draftFeedback}
      />
    </Field>
  );
}
