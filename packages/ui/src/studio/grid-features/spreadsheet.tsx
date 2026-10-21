"use client";

import { useId, type ReactElement } from "react";
import {
  recordsTableStatusBarFieldTypes,
  recordsTableStatusBarOperations,
  type RecordsTableQueryFacts,
  type RecordsTableStatusBarOperation,
  type SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../../components/item";
import { Label } from "../../components/label";
import { Switch } from "../../components/switch";

type Group = Extract<SourceBlockPropertyValueContract, { kind: "group" }>;

const operationLabels: Readonly<Record<RecordsTableStatusBarOperation, string>> = {
  count: "Count",
  sum: "Sum",
  average: "Average",
  minimum: "Minimum",
  maximum: "Maximum",
};

/**
 * Compact controls share the authored feature group the runtime reads: the two switches, and the
 * status bar, which totals a selected range for the fields and totals the builder switches on. Only
 * the table's columns that hold a number, money or date are offered; the feature's check gives the
 * same sentence publication does.
 */
export function StudioSpreadsheetEditor({
  value,
  facts,
  columns,
  disabled,
  onChange,
}: Readonly<{
  value: Group;
  facts: RecordsTableQueryFacts;
  /** The fields the table shows as columns, as the draft names them. */
  columns: readonly string[];
  disabled: boolean;
  onChange: (next: Group) => void;
}>): ReactElement {
  const id = useId();
  const held = (key: string) => value.properties[key];
  const fields =
    held("status_bar_fields")?.kind === "list"
      ? (
          held("status_bar_fields") as Extract<SourceBlockPropertyValueContract, { kind: "list" }>
        ).items.flatMap((item) => (item.kind === "field_reference" ? [item.field] : []))
      : [];
  const operations =
    held("status_bar_operations")?.kind === "list"
      ? (
          held("status_bar_operations") as Extract<
            SourceBlockPropertyValueContract,
            { kind: "list" }
          >
        ).items.flatMap((item) => (item.kind === "choice" ? [item.value] : []))
      : [];
  const offered = facts.fields.filter(
    (field) =>
      columns.includes(field.field) && recordsTableStatusBarFieldTypes.includes(field.type),
  );
  const write = (properties: Group["properties"]): void =>
    onChange({ kind: "group", properties: { ...value.properties, ...properties } });
  return (
    <ItemGroup className="gap-1 pb-2">
      {(
        [
          ["range_select", "Range selection"],
          ["find", "Find on page"],
        ] as const
      ).map(([key, label]) => {
        const setting = value.properties[key];
        if (setting?.kind !== "boolean")
          throw new Error(`Spreadsheet setting ${key} is incomplete`);
        return (
          <Item key={key} size="sm" className="px-0">
            <ItemContent>
              <ItemTitle>
                <Label htmlFor={`${id}-${key}`}>{label}</Label>
              </ItemTitle>
            </ItemContent>
            <ItemActions>
              <Switch
                id={`${id}-${key}`}
                checked={setting.value}
                disabled={disabled}
                onCheckedChange={(checked) => write({ [key]: { kind: "boolean", value: checked } })}
              />
            </ItemActions>
          </Item>
        );
      })}
      <Item size="sm" className="px-0">
        <ItemContent>
          <ItemTitle>Status bar</ItemTitle>
          <ItemDescription>
            {offered.length === 0
              ? "Status bar totals need a number, money or date field the query reads"
              : "Totals of the selected range, calculated on the server for this page. Choose the fields and the totals."}
          </ItemDescription>
        </ItemContent>
      </Item>
      {offered.map((field) => (
        <Item key={field.field} size="sm" className="px-0">
          <ItemContent>
            <ItemTitle>
              <Label htmlFor={`${id}-field-${field.field}`}>{field.label}</Label>
            </ItemTitle>
          </ItemContent>
          <ItemActions>
            <Switch
              id={`${id}-field-${field.field}`}
              checked={fields.includes(field.field)}
              disabled={disabled}
              onCheckedChange={(checked) =>
                write({
                  status_bar_fields: {
                    kind: "list",
                    items: (checked
                      ? [...fields, field.field]
                      : fields.filter((held) => held !== field.field)
                    ).map((reference) => ({ kind: "field_reference" as const, field: reference })),
                  },
                })
              }
            />
          </ItemActions>
        </Item>
      ))}
      {offered.length === 0
        ? null
        : recordsTableStatusBarOperations.map((operation) => (
            <Item key={operation} size="sm" className="px-0">
              <ItemContent>
                <ItemTitle>
                  <Label htmlFor={`${id}-operation-${operation}`}>
                    {operationLabels[operation]}
                  </Label>
                </ItemTitle>
              </ItemContent>
              <ItemActions>
                <Switch
                  id={`${id}-operation-${operation}`}
                  checked={operations.includes(operation)}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    write({
                      status_bar_operations: {
                        kind: "list",
                        items: recordsTableStatusBarOperations
                          .filter((known) =>
                            known === operation ? checked : operations.includes(known),
                          )
                          .map((choice) => ({ kind: "choice" as const, value: choice })),
                      },
                    })
                  }
                />
              </ItemActions>
            </Item>
          ))}
    </ItemGroup>
  );
}
