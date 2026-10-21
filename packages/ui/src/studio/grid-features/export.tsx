"use client";

import { useId, useState, type ReactElement } from "react";
import {
  RECORDS_TABLE_EXPORT_MAXIMUM_ROWS,
  recordsTableExportFormatLabels,
  recordsTableExportFormats,
  type SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";
import { Input } from "../../components/input";
import { Label } from "../../components/label";
import { Checkbox } from "../../components/checkbox";

type Group = Extract<SourceBlockPropertyValueContract, { kind: "group" }>;

/**
 * The Export feature's two authored settings: file formats and the most records one
 * export holds. A value the check refuses is kept as typed, so the sentence beside the switch
 * explains it instead of the field jumping back.
 */
export function StudioExportEditor({
  value,
  disabled,
  onChange,
}: Readonly<{
  value: Group;
  disabled: boolean;
  onChange: (next: Group) => void;
}>): ReactElement {
  const id = useId();
  const held = value.properties["max_rows"];
  const formats = value.properties["formats"];
  const selected = formats?.kind === "list" ? formats.items : [];
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
        <legend className="text-sm font-medium">File formats</legend>
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
      <Label htmlFor={`${id}-max-rows`}>Most records in one export</Label>
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
      <p className="text-xs text-muted-foreground">
        Up to {RECORDS_TABLE_EXPORT_MAXIMUM_ROWS.toLocaleString("en-US")} records.
      </p>
    </div>
  );
}
