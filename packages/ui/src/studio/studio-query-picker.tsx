"use client";

import type { ReactElement } from "react";
import { Button } from "../components/button";
import { Plus } from "lucide-react";
import {
  StudioReferencePicker,
  studioBorrowedGroup,
  type StudioReferencePickerOption,
} from "./studio-reference-picker";
import { Label } from "../components/label";
import { StudioHelp } from "./studio-field";
import type { StudioQueryChoice } from "./contextual-palette";

export const borrowableOption = (
  choice: Readonly<{ reference: string; label: string; borrowedFrom?: string | undefined }>,
): StudioReferencePickerOption => ({
  value: choice.reference,
  label: choice.label,
  group:
    choice.borrowedFrom === undefined
      ? "This application"
      : studioBorrowedGroup(choice.borrowedFrom),
  readOnly: choice.borrowedFrom !== undefined,
});

const queryInputsDescription = (query: StudioQueryChoice): string | undefined =>
  query.inputs.length === 0
    ? undefined
    : `Asks for ${query.inputs.map((input) => (input.required ? input.label : `${input.label} (optional)`)).join(", ")}`;

/**
 * The data a block reads: one of the application's own queries or an exposed query of a Module it
 * uses, which is chosen as it is. `onNewQuery` opens the query sheet, which creates a query in one
 * of the application's own Modules and comes back with it chosen.
 */
export function StudioQueryPicker({
  id,
  queries,
  recordQueries = [],
  value,
  onChange,
  onNewQuery,
  disabled,
}: Readonly<{
  id: string;
  queries: readonly StudioQueryChoice[];
  recordQueries?: readonly StudioQueryChoice[] | undefined;
  value: string;
  onChange: (reference: string) => void;
  onNewQuery?: (() => void) | undefined;
  disabled: boolean;
}>): ReactElement {
  return (
    <div className="space-y-2" data-vortex-setting="query">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1">
          <Label htmlFor={id}>Data</Label>
          <StudioHelp hint="Choose a record type to show all its records, or use an existing query." />
        </span>
        {onNewQuery === undefined ? null : (
          <Button type="button" size="xs" variant="ghost" disabled={disabled} onClick={onNewQuery}>
            <Plus />
            New query
          </Button>
        )}
      </div>
      <StudioReferencePicker
        id={id}
        value={value}
        disabled={disabled}
        unset="Choose data"
        onChange={onChange}
        options={[
          ...recordQueries.map((query) => ({
            value: query.reference,
            label: query.label,
            group: "Record types",
            description: `Show all ${query.label.toLowerCase()}`,
          })),
          ...queries.map((query) => ({
            ...borrowableOption(query),
            description: queryInputsDescription(query),
          })),
        ]}
      />
      {queries.length === 0 && recordQueries.length === 0 && (
        <p role="status" className="text-sm">
          {onNewQuery === undefined
            ? "Add a query in the Data tab first."
            : "Add a query with New query."}
        </p>
      )}
    </div>
  );
}

/**
 * The typed controls of a set of declared settings, each with its label, whether it is required,
 * its help and its default. `values` holds the settings that are set; a setting left out takes
 * its default.
 */
