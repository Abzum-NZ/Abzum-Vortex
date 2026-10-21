"use client";

import type { ReactElement } from "react";
import {
  recordsTableFieldNotEditableReason,
  type RecordsTableQueryFacts,
  type SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";
import { StudioGridFieldPicker } from "./field-picker";

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
      <StudioGridFieldPicker
        fields={facts.fields.filter((field) => columns.includes(field.field))}
        chosen={chosen}
        disabled={disabled}
        reason={recordsTableFieldNotEditableReason}
        onChange={write}
      />
    </div>
  );
}
