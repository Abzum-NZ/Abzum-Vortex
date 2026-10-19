"use client";
import { useMemo } from "react";
import type { ModuleField } from "@vortex/platform/schema";
import {
  readStudioQueryFilter,
  StudioConditionControls,
  studioQueryFilterContext,
  writeStudioQueryFilter,
} from "@vortex/ui/studio";

/**
 * A condition over one record type's fields, built with the shared typed condition controls and
 * stored in the authored form a query filter uses: a calculation's yes-or-no condition and a
 * total's filter of related records. The controls work on the saved draft's compiled fields.
 */
export function StudioFormulaCondition({
  label,
  condition,
  compiled,
  fieldKeys,
  disabled,
  onChange,
}: Readonly<{
  label: string;
  /** The authored condition; undefined when there is none yet. */
  condition: unknown;
  /** The saved draft's compiled fields of the record type the condition reads, or undefined before it is saved. */
  compiled: readonly ModuleField[] | undefined;
  /** The fields the condition may compare, by key. */
  fieldKeys: ReadonlySet<string>;
  disabled: boolean;
  /** The authored condition (undefined for none), and whether every comparison is complete. */
  onChange: (condition: unknown, valid: boolean) => void;
}>) {
  const context = useMemo(
    () => (compiled === undefined ? undefined : studioQueryFilterContext(compiled, fieldKeys, [])),
    [compiled, fieldKeys],
  );
  const reading = useMemo(
    () =>
      compiled === undefined
        ? undefined
        : readStudioQueryFilter(
            (condition ?? null) as Parameters<typeof readStudioQueryFilter>[0],
            (key) => compiled.find((field) => field.key === key)?.fieldId,
          ),
    [condition, compiled],
  );
  if (compiled === undefined || context === undefined || reading === undefined)
    return (
      <p role="note" className="text-sm">
        Save the draft to build this condition: its controls work on the saved fields.
      </p>
    );
  if (reading.kind === "unreadable")
    return (
      <p role="note" className="text-sm">
        {reading.reason} The condition stays as it is.
      </p>
    );
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <StudioConditionControls
        label={label}
        context={context}
        {...(reading.condition === undefined ? {} : { value: reading.condition })}
        onChange={(next, validation) => {
          const written = writeStudioQueryFilter(
            next,
            (fieldId) => compiled.find((field) => field.fieldId === fieldId)?.key,
          );
          onChange(
            written === null ? undefined : (written ?? condition),
            validation.isValid && written !== undefined,
          );
        }}
      />
    </fieldset>
  );
}
