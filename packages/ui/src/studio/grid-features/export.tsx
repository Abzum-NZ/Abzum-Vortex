"use client";
import { StudioHelp } from "../studio-field";

import { useId, useState, type ReactElement } from "react";
import {
  formatCount,
  RECORDS_TABLE_EXPORT_MAXIMUM_ROWS,
  recordsTableExportFormatLabels,
  recordsTableExportFormats,
  type RecordsTableQueryFacts,
  type SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";
import { Input } from "../../components/input";
import { Label } from "../../components/label";
import { Checkbox } from "../../components/checkbox";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "../../components/field";
import { ToggleGroup, ToggleGroupItem } from "../../components/toggle-group";

type Group = Extract<SourceBlockPropertyValueContract, { kind: "group" }>;

/**
 * The Export feature's authored settings: file formats, the columns whose file holds the stored
 * value instead of what the table shows, and the most records one export holds. A value the check refuses is kept as typed, so the sentence beside the switch
 * explains it instead of the field jumping back.
 */
export function StudioExportEditor({
  value,
  facts,
  columns,
  disabled,
  onChange,
}: Readonly<{
  value: Group;
  facts: RecordsTableQueryFacts;
  /** The fields the table shows as columns, as the draft names them; only these can be exported. */
  columns: readonly string[];
  disabled: boolean;
  onChange: (next: Group) => void;
}>): ReactElement {
  const id = useId();
  const held = value.properties["max_rows"];
  const formats = value.properties["formats"];
  const selected = formats?.kind === "list" ? formats.items : [];
  const rawHeld = value.properties["raw_columns"];
  const rawChosen =
    rawHeld?.kind === "list"
      ? rawHeld.items.flatMap((item) => (item.kind === "field_reference" ? [item.field] : []))
      : [];
  const heldText = held?.kind === "number" ? String(held.value) : "";
  const [typed, setTyped] = useState(heldText);
  // Undo, redo or a reload that changes the stored limit shows it; typing keeps what was typed.
  const [shownHeld, setShownHeld] = useState(heldText);
  if (shownHeld !== heldText) {
    setShownHeld(heldText);
    if (Number(typed) !== Number(heldText)) setTyped(heldText);
  }
  return (
    <div className="space-y-2 pb-3">
      <p className="text-sm text-muted-foreground">
        Download the columns shown, as flat records. Selections above the row limit are refused.
      </p>
      <fieldset className="space-y-2" disabled={disabled}>
        <FieldLegend variant="label">File formats</FieldLegend>
        {recordsTableExportFormats.map((format) => {
          const checked = selected.some((item) => item.kind === "choice" && item.value === format);
          return (
            <div key={format} className="flex items-center gap-2">
              <Checkbox
                id={`${id}-${format}`}
                checked={checked}
                disabled={disabled || (checked && selected.length === 1)}
                onCheckedChange={(next) => {
                  const items = next
                    ? [...selected, { kind: "choice" as const, value: format }]
                    : selected.filter((item) => item.kind !== "choice" || item.value !== format);
                  onChange({
                    kind: "group",
                    properties: { ...value.properties, formats: { kind: "list", items } },
                  });
                }}
              />
              <Label htmlFor={`${id}-${format}`}>{recordsTableExportFormatLabels[format]}</Label>
            </div>
          );
        })}
      </fieldset>
      <FieldSet disabled={disabled}>
        <div className="flex items-center gap-1">
          <FieldLegend variant="label">Values per column</FieldLegend>
          <StudioHelp hint="Every column downloads as the table shows it. Choose Raw to download a column's stored value instead: the choice key, the ISO date, the canonical number." />
        </div>
        <FieldGroup>
          {facts.fields
            .filter((field) => columns.includes(field.field))
            .map((field) => (
              <Field key={field.field} orientation="horizontal">
                <FieldLabel>{field.label}</FieldLabel>
                <ToggleGroup
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  value={[rawChosen.includes(field.field) ? "raw" : "shown"]}
                  onValueChange={(next) => {
                    const raw = next[0] === "raw";
                    const fields = raw
                      ? [...rawChosen.filter((key) => key !== field.field), field.field]
                      : rawChosen.filter((key) => key !== field.field);
                    onChange({
                      kind: "group",
                      properties: {
                        ...value.properties,
                        raw_columns: {
                          kind: "list",
                          items: fields.map((key) => ({
                            kind: "field_reference" as const,
                            field: key,
                          })),
                        },
                      },
                    });
                  }}
                >
                  <ToggleGroupItem value="shown">As shown</ToggleGroupItem>
                  <ToggleGroupItem value="raw">Raw</ToggleGroupItem>
                </ToggleGroup>
              </Field>
            ))}
        </FieldGroup>
      </FieldSet>
      <div className="flex items-center gap-1">
        <Label htmlFor={`${id}-max-rows`}>Most records in one export</Label>
        <StudioHelp hint={`Up to ${formatCount(RECORDS_TABLE_EXPORT_MAXIMUM_ROWS)} records.`} />
      </div>
      <Input
        id={`${id}-max-rows`}
        type="number"
        inputMode="numeric"
        min={1}
        max={RECORDS_TABLE_EXPORT_MAXIMUM_ROWS}
        step={1}
        value={typed}
        disabled={disabled}
        onChange={(event) => {
          const text = event.target.value;
          setTyped(text);
          const rows = Number(text);
          const others = Object.fromEntries(
            Object.entries(value.properties).filter(([key]) => key !== "max_rows"),
          );
          onChange({
            kind: "group",
            properties:
              text.trim() === "" || !Number.isFinite(rows)
                ? others
                : { ...others, max_rows: { kind: "number", value: rows } },
          });
        }}
      />
    </div>
  );
}
