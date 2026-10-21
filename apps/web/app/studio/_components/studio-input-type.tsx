"use client";
import type { ReactNode } from "react";
import { StudioOptionControl } from "@vortex/ui/studio";
import { useStudioDraftHeld } from "./use-studio-draft-held";

/** A record type change stays at the control until the builder has chosen its record types. */
export function StudioInputType<Type extends string>({
  id,
  type,
  recordTypes,
  options,
  disabled = false,
  onChange,
  children,
}: Readonly<{
  id: string;
  type: Type;
  recordTypes: readonly string[];
  options: readonly Readonly<{ value: Type; label: string }>[];
  disabled?: boolean;
  onChange: (type: Type, recordTypes: readonly string[]) => string | undefined;
  children: (records: readonly string[], change: (records: readonly string[]) => void) => ReactNode;
}>) {
  const control = useStudioDraftHeld({ type, recordTypes });
  const change = (nextType: Type, records: readonly string[]) => {
    const next = { type: nextType, recordTypes: records };
    if (nextType === "record_reference" && records.length === 0) {
      control.hold(next, "Choose the record type");
      return;
    }
    const problem = onChange(nextType, records);
    if (problem === undefined) control.applied(next);
    else control.hold(next, problem);
  };
  return (
    <div className="space-y-2">
      <StudioOptionControl
        id={id}
        value={control.value.type}
        options={options}
        disabled={disabled}
        onChange={(value) => change(value as Type, [])}
      />
      {control.value.type === "record_reference" &&
        children(control.value.recordTypes, (records) => change(control.value.type, records))}
      {control.problem !== "" && (
        <p role="status" className="text-sm text-destructive">
          {control.problem}
        </p>
      )}
    </div>
  );
}
