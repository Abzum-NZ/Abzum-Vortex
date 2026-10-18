"use client";
import { useState } from "react";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@vortex/ui/components/native-select";
import { Textarea } from "@vortex/ui/components/textarea";
import type { FlowLiteral } from "@vortex/platform/schema";
import {
  describeStudioFlowValue, studioFixedLiteral, studioFixedLiteralType, studioFlowReferenceToken,
  type StudioFlowReferenceChoice, type StudioFlowValueSource,
} from "@vortex/ui/studio";

/**
 * One flow value: where it comes from (a fixed value, or something the flow can read at this step)
 * and, for a fixed value, the value itself typed by what the setting expects. A value the control
 * does not build (a calculation, a built set of values) is shown and kept until another is chosen.
 */

type LiteralType = FlowLiteral["type"];

const groups = ["Inputs", "Variables", "Earlier steps", "The record", "The run"] as const;

/** A fixed value's starting literal for a type. */
const startLiteral = (type: LiteralType, options: readonly Readonly<{ value: string }>[]): FlowLiteral =>
  type === "yes_no" ? { type, value: false }
    : type === "whole_number" ? { type, value: 0 }
      : type === "several_choices" ? { type, value: [] }
        : type === "choice" && options[0] !== undefined ? { type, value: options[0].value }
          : { type, value: "" };

const literalText = (literal: FlowLiteral): string =>
  Array.isArray(literal.value) ? literal.value.join(", ") : typeof literal.value === "string" ? literal.value
    : literal.value === null ? "" : String(literal.value);

function FixedInput({ id, label, literal, options, long, disabled, onChange }: Readonly<{
  id: string; label: string; literal: FlowLiteral; options: readonly Readonly<{ value: string; label: string }>[]; long: boolean;
  disabled: boolean; onChange: (literal: FlowLiteral) => void;
}>) {
  const current = literalText(literal);
  const [draft, setDraft] = useState(current);
  const [seen, setSeen] = useState(current);
  if (current !== seen) { setSeen(current); setDraft(current); }
  if (literal.type === "yes_no")
    return <div className="flex items-center gap-2"><Checkbox id={id} disabled={disabled} checked={literal.value === true}
      onCheckedChange={(checked) => onChange({ type: "yes_no", value: checked === true })} /><Label htmlFor={id}>Yes</Label></div>;
  if (literal.type === "choice" && options.length > 0)
    return <NativeSelect id={id} aria-label={`${label} value`} className="w-full" disabled={disabled} value={current}
      aria-invalid={!options.some((option) => option.value === current)}
      onChange={(event) => onChange({ type: "choice", value: event.target.value })}>
      {options.some((option) => option.value === current) ? null : <NativeSelectOption value={current}>{`${current} (not an option)`}</NativeSelectOption>}
      {options.map((option) => <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>)}
    </NativeSelect>;
  const change = (text: string) => {
    setDraft(text);
    const built = studioFixedLiteral(literal.type, text, "value");
    // A value that does not fit its type is kept as typed; the step refuses it, saying where it is.
    onChange(built.ok ? built.literal : { type: literal.type, value: text });
  };
  const hint = literal.type === "date" ? "2026-01-31" : literal.type === "date_time" ? "2026-01-31T09:30:00Z"
    : literal.type === "several_choices" ? "first, second" : undefined;
  return long
    ? <Textarea id={id} aria-label={`${label} value`} disabled={disabled} maxLength={2_000} value={draft} onChange={(event) => change(event.target.value)} />
    : <Input id={id} aria-label={`${label} value`} disabled={disabled} value={draft} placeholder={hint}
        inputMode={literal.type === "whole_number" || literal.type === "decimal_number" ? "decimal" : undefined}
        onChange={(event) => change(event.target.value)} />;
}

export function StudioFlowValueControl({ id, label, value, valueType, options = [], references, unset, long = false,
  disabled, onChange }: Readonly<{
  id: string;
  label: string;
  value: StudioFlowValueSource | null;
  /** What the setting expects; undefined accepts any value. */
  valueType: string | undefined;
  /** The options of a choice, when the value sets one. */
  options?: readonly Readonly<{ value: string; label: string }>[];
  references: readonly StudioFlowReferenceChoice[];
  /** The words for leaving it unset, when it may be left unset. */
  unset?: string;
  long?: boolean;
  disabled: boolean;
  onChange: (value: StudioFlowValueSource | null) => void;
}>) {
  const fixedType = options.length > 0 ? "choice" : studioFixedLiteralType(valueType);
  const offered = references.filter((choice) => valueType === undefined || choice.type === undefined || choice.type === "json" ||
    choice.type === valueType || (valueType === "text" && (choice.type === "choice" || choice.type === "formatted_text")) ||
    (valueType === "choice" && choice.type === "text") || valueType === "json");
  const token = value === null ? "" : value.kind === "fixed" ? "fixed" : value.kind === "kept" ? "kept" : studioFlowReferenceToken(value.reference);
  const known = token === "" || token === "fixed" || token === "kept" || offered.some((choice) => choice.token === token);
  return <div className="space-y-1.5">
    <Label htmlFor={`${id}-from`}>{label}</Label>
    <NativeSelect id={`${id}-from`} className="w-full" disabled={disabled} value={token} aria-invalid={!known}
      onChange={(event) => {
        const next = event.target.value;
        if (next === "") onChange(null);
        else if (next === "fixed" && fixedType !== undefined) onChange({ kind: "fixed", literal: startLiteral(fixedType, options) });
        else {
          const choice = offered.find((entry) => entry.token === next);
          if (choice !== undefined) onChange({ kind: "reference", reference: choice.reference });
        }
      }}>
      {unset === undefined && value !== null ? null : <NativeSelectOption value="">{unset ?? "Choose where it comes from…"}</NativeSelectOption>}
      {fixedType === undefined ? null : <NativeSelectOption value="fixed">A fixed value</NativeSelectOption>}
      {value?.kind === "kept" ? <NativeSelectOption value="kept">{describeStudioFlowValue(value, references)} (kept as it is)</NativeSelectOption> : null}
      {known ? null : <NativeSelectOption value={token}>A value this step can no longer read</NativeSelectOption>}
      {groups.map((group) => {
        const entries = offered.filter((choice) => choice.group === group);
        return entries.length === 0 ? null : <NativeSelectOptGroup key={group} label={group}>
          {entries.map((choice) => <NativeSelectOption key={choice.token} value={choice.token}>{choice.label}</NativeSelectOption>)}
        </NativeSelectOptGroup>;
      })}
    </NativeSelect>
    {value?.kind === "fixed" && <FixedInput id={id} label={label} literal={value.literal} options={options} long={long} disabled={disabled}
      onChange={(literal) => onChange({ kind: "fixed", literal })} />}
    {!known && <p role="alert" className="text-xs text-destructive">This step cannot read that value here any more. Choose another.</p>}
  </div>;
}
