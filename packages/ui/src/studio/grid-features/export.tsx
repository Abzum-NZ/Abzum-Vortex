"use client";

import { useId, useState, type ReactElement } from "react";
import {
  RECORDS_TABLE_EXPORT_MAXIMUM_ROWS,
  type SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";
import { Input } from "../../components/input";
import { Label } from "../../components/label";

type Group = Extract<SourceBlockPropertyValueContract, { kind: "group" }>;

/**
 * The Export feature's two authored settings: the file format (CSV today) and the most records one
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
  const [typed, setTyped] = useState(held?.kind === "number" ? String(held.value) : "");
  return (
    <div className="space-y-2 pb-3">
      <p className="text-sm text-muted-foreground">
        People download a CSV file of the columns they see. Records are never grouped in the file,
        and a selection above the row limit is refused, never cut short.
      </p>
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
      <p className="text-xs text-muted-foreground">Up to 100,000 records.</p>
    </div>
  );
}
