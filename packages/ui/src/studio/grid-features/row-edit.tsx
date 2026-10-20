"use client";

import { useId, type ReactElement } from "react";
import {
  recordsTableFieldNotEditableReason,
  type RecordsTableQueryFacts,
  type SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";
import { Button } from "../../components/button";
import { Label } from "../../components/label";
import { StudioReferencePicker } from "../studio-reference-picker";

type Group = Extract<SourceBlockPropertyValueContract, { kind: "group" }>;

export function StudioRowEditEditor({
  value,
  facts,
  columns,
  disabled,
  onChange,
}: Readonly<{
  value: Group;
  facts: RecordsTableQueryFacts;
  columns: readonly string[];
  disabled: boolean;
  onChange: (next: Group) => void;
}>): ReactElement {
  const id = useId();
  const held = value.properties["fields"];
  const chosen =
    held?.kind === "list"
      ? held.items.flatMap((item) => (item.kind === "field_reference" ? [item.field] : []))
      : [];
  const event = value.properties["event_id"];
  const write = (fields: readonly string[]): void =>
    onChange({
      ...value,
      properties: {
        ...value.properties,
        fields: {
          kind: "list",
          items: fields.map((field) => ({ kind: "field_reference", field })),
        },
      },
    });
  return (
    <div className="space-y-3 pb-3">
      <p className="text-sm text-muted-foreground">
        {event?.kind === "text" && event.value.length > 0
          ? "The workflow for a saved row saves all changed fields together."
          : "Name the action that saves the row: add “When a row is saved” under Workflow."}
      </p>
      <Label htmlFor={id}>Editable fields</Label>
      <StudioReferencePicker
        id={id}
        value=""
        unset="Add a field"
        disabled={disabled}
        options={facts.fields
          .filter((field) => columns.includes(field.field) && !chosen.includes(field.field))
          .map((field) => {
            const reason = recordsTableFieldNotEditableReason(field);
            return {
              value: field.field,
              label: field.label,
              disabled: reason !== undefined,
              description: reason,
            };
          })}
        onChange={(field) => {
          if (field !== "") write([...chosen, field]);
        }}
      />
      {chosen.map((field) => (
        <div key={field} className="flex items-center justify-between gap-2 text-sm">
          <span>{facts.fields.find((candidate) => candidate.field === field)?.label ?? field}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label={`Remove ${facts.fields.find((candidate) => candidate.field === field)?.label ?? field}`}
            onClick={() => write(chosen.filter((candidate) => candidate !== field))}
          >
            Remove
          </Button>
        </div>
      ))}
    </div>
  );
}
