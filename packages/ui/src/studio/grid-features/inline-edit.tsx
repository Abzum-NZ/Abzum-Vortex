"use client";

import type { ReactElement } from "react";
import {
  recordsTableFieldNotEditableReason,
  type RecordsTableQueryFacts,
  type SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";
import { Badge } from "../../components/badge";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "../../components/item";
import { StudioGridFieldPicker } from "./field-picker";

type Group = Extract<SourceBlockPropertyValueContract, { kind: "group" }>;

/**
 * The Inline editing settings, drawn from the bound query's fields: each column of the table that
 * holds a stored value people may change gets a switch, and every other column says why it cannot
 * be edited in a cell (a calculated or system value, say) with the same sentence publication gives.
 * The action that saves a change is the workflow added for "When a value is edited", which names
 * itself in the feature; here the builder only sees whether it is in place.
 */
export function StudioInlineEditEditor({
  value,
  facts,
  columns,
  disabled,
  onChange,
}: Readonly<{
  value: Group;
  facts: RecordsTableQueryFacts;
  /** The fields the table shows as columns, as the draft names them; only these can be edited. */
  columns: readonly string[];
  disabled: boolean;
  onChange: (next: Group) => void;
}>): ReactElement {
  const held = value.properties["fields"];
  const chosen =
    held?.kind === "list"
      ? held.items.flatMap((item) => (item.kind === "field_reference" ? [item.field] : []))
      : [];
  const eventId = value.properties["event_id"];
  const hasAction = eventId?.kind === "text" && eventId.value.trim().length > 0;
  const shown = facts.fields.filter((field) => columns.includes(field.field));
  const write = (fields: readonly string[]): void =>
    onChange({
      ...value,
      properties: {
        ...value.properties,
        fields: {
          kind: "list",
          items: fields.map((field) => ({ kind: "field_reference" as const, field })),
        },
      },
    });
  return (
    <ItemGroup className="gap-1 pb-2">
      <Item size="sm" className="px-0">
        <ItemContent>
          <ItemTitle>
            Save action
            {hasAction ? (
              <Badge variant="outline" className="border-transparent bg-success/10 text-success">
                In place
              </Badge>
            ) : (
              <Badge variant="outline">Not added</Badge>
            )}
          </ItemTitle>
          <ItemDescription>
            {hasAction
              ? "Each change is saved by the workflow for an edited value."
              : "Use Fix to add the flow that saves edited values and choose the editable columns together."}
          </ItemDescription>
        </ItemContent>
      </Item>
      {shown.length === 0 ? (
        <ItemDescription>Add the columns people may edit to the table first.</ItemDescription>
      ) : (
        <StudioGridFieldPicker
          fields={shown}
          chosen={chosen}
          disabled={disabled}
          reason={recordsTableFieldNotEditableReason}
          onChange={write}
        />
      )}
    </ItemGroup>
  );
}
