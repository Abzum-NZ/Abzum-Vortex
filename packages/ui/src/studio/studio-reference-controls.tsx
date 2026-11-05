"use client";

import type { ReactElement } from "react";
import { StudioRecordReferenceControl } from "./studio-record-reference-control";
import { borrowableOption } from "./studio-query-picker";
import { StudioReferencePicker, type StudioReferencePickerOption } from "./studio-reference-picker";
import {
  studioFittingFields,
  studioUnsetLabel,
  type ControlProps,
  type SettingValue,
} from "@vortex/platform/schema";

/**
 * The controls of the reference settings: one by name (pages, record types, queries, actions,
 * relationships, totals), one for a field of the data the block reads and one for a record. The
 * inspector draws them as Puck fields; a Set-up dialog and the entries of a group or list draw
 * them through the same controls.
 */

/** A reference to something the application or an application it uses declares, chosen by name. */
export function StudioReferenceControl({
  id,
  property,
  value,
  onChange,
  choices,
  disabled,
  descriptionId,
  invalid,
}: ControlProps): ReactElement {
  const unset = studioUnsetLabel(property, undefined);
  const picked = (
    current: string,
    options: readonly StudioReferencePickerOption[],
    make: (next: string) => NonNullable<SettingValue>,
    emptyText?: string,
  ) => (
    <StudioReferencePicker
      id={id}
      aria-describedby={descriptionId}
      aria-invalid={invalid || undefined}
      disabled={disabled}
      value={current}
      unset={options.length === 0 && emptyText !== undefined ? emptyText : unset}
      options={options}
      onChange={(next) => onChange(next === "" ? undefined : make(next))}
    />
  );
  switch (property.kind) {
    case "total_reference":
      return picked(
        value?.kind === "total_reference" ? value.value : "",
        choices.totals.map((total) => ({
          value: total.alias,
          label: total.label,
          group: "Totals of the query",
        })),
        (next) => ({ kind: "total_reference", value: next }),
        "Add a total to the query first",
      );
    case "query_reference":
      return picked(
        value?.kind === "query_reference" ? value.query : "",
        choices.queries.map(borrowableOption),
        (next) => ({ kind: "query_reference", query: next }),
      );
    case "page_reference":
      return picked(
        value?.kind === "page_reference" ? value.page : "",
        choices.pages.map((page) => ({ value: page.key, label: page.label })),
        (next) => ({ kind: "page_reference", page: next }),
      );
    case "record_type_reference":
      return picked(
        value?.kind === "record_type_reference" ? value.record_type : "",
        choices.recordTypes.map((recordType) => ({
          value: recordType.key,
          label: recordType.label,
        })),
        (next) => ({ kind: "record_type_reference", record_type: next }),
      );
    case "action_reference":
      return picked(
        value?.kind === "action_reference" ? value.action : "",
        choices.actions.map(borrowableOption),
        (next) => ({ kind: "action_reference", action: next }),
        "This application has no actions yet",
      );
    case "relationship_reference":
      return picked(
        value?.kind === "relationship_reference" ? value.relationship : "",
        choices.relationships.map(borrowableOption),
        (next) => ({ kind: "relationship_reference", relationship: next }),
        "Its records have no relationships",
      );
    default:
      // The settings switch calls this only for the six kinds above.
      return <></>;
  }
}

/** A field of the data the block reads, among the ones the setting's declaration allows. */
export function StudioFieldPickerControl({
  id,
  property,
  value,
  onChange,
  choices,
  disabled,
  descriptionId,
  invalid,
}: ControlProps): ReactElement {
  return (
    <StudioReferencePicker
      id={id}
      aria-describedby={descriptionId}
      aria-invalid={invalid || undefined}
      disabled={disabled}
      value={value?.kind === "field_reference" ? value.field : ""}
      unset={
        choices.fields.length === 0
          ? "Choose the data first"
          : studioUnsetLabel(property, undefined)
      }
      options={studioFittingFields(property, choices.fields).map((field) => {
        const taken =
          property.derivesFieldInput === true &&
          field.reference !== (value?.kind === "field_reference" ? value.field : "") &&
          choices.fieldsInUse?.has(field.reference.slice(field.reference.lastIndexOf(".") + 1)) ===
            true;
        return {
          value: field.reference,
          label: field.label,
          ...(taken
            ? { disabled: true, description: "Already used by another input in this form" }
            : {}),
        };
      })}
      onChange={(next) =>
        onChange(next === "" ? undefined : { kind: "field_reference", field: next })
      }
    />
  );
}

/** One record of a record type, read 40 at a time. */
export function StudioRecordControl({
  id,
  property,
  value,
  onChange,
  choices,
  disabled,
  descriptionId,
  invalid,
}: ControlProps): ReactElement {
  return (
    <StudioRecordReferenceControl
      id={id}
      label={property.label}
      aria-describedby={descriptionId}
      aria-invalid={invalid || undefined}
      disabled={disabled}
      recordTypes={choices.recordTypes}
      read={choices.records}
      value={
        value?.kind === "record_reference"
          ? { recordType: value.record_type, recordId: value.record_id }
          : undefined
      }
      onChange={(next) =>
        onChange(
          next === undefined
            ? undefined
            : {
                kind: "record_reference",
                record_type: next.recordType,
                record_id: next.recordId,
              },
        )
      }
    />
  );
}
