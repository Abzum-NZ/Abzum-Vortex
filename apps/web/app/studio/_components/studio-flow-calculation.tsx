"use client";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import { flowRoundingModeSchema, type FlowRoundingMode } from "@vortex/platform/schema";
import type { StudioFlowCalculation, StudioFlowCalculationOperand, StudioFlowCalculationReference } from "@vortex/ui/studio";

/** The typed control of a Calculate step's formula: one operator over two numbers or numeric inputs. */

const operators: readonly Readonly<{ value: StudioFlowCalculation["operator"]; label: string }>[] = [
  { value: "add", label: "Add" }, { value: "subtract", label: "Subtract" },
  { value: "multiply", label: "Multiply" }, { value: "divide", label: "Divide" },
];

const roundingLabels: Readonly<Record<FlowRoundingMode, string>> = {
  half_up: "Round half up", half_even: "Round half to even", half_down: "Round half down",
  up: "Round up", down: "Round down", ceiling: "Round towards plus infinity", floor: "Round towards minus infinity",
} as Readonly<Record<FlowRoundingMode, string>>;

export const defaultStudioFlowCalculation: StudioFlowCalculation = {
  operator: "add", left: { kind: "literal", literal: { type: "whole_number", value: 0 } },
  right: { kind: "literal", literal: { type: "whole_number", value: 0 } }, scale: 0, rounding: "half_up",
};

const referenceKey = (reference: Readonly<{ kind: string; name: string }>) => `${reference.kind}:${reference.name}`;

function OperandControl({ id, label, operand, references, disabled, onChange }: Readonly<{
  id: string; label: string; operand: StudioFlowCalculationOperand; references: readonly StudioFlowCalculationReference[];
  disabled: boolean; onChange: (operand: StudioFlowCalculationOperand) => void;
}>) {
  const source = operand.kind === "literal" ? "number" : referenceKey(operand);
  return <div className="flex flex-col gap-1.5">
    <Label htmlFor={`${id}-source`}>{label}</Label>
    <NativeSelect id={`${id}-source`} className="w-full" disabled={disabled} value={source} onChange={(event) => {
      const chosen = references.find((reference) => referenceKey(reference) === event.target.value);
      onChange(chosen === undefined ? { kind: "literal", literal: { type: "whole_number", value: 0 } } : { kind: chosen.kind, name: chosen.name });
    }}>
      <NativeSelectOption value="number">A number</NativeSelectOption>
      {references.map((reference) => <NativeSelectOption key={referenceKey(reference)} value={referenceKey(reference)}>
        {reference.kind === "input" ? "Input" : "Variable"}: {reference.name.replace(/_/g, " ")}</NativeSelectOption>)}
    </NativeSelect>
    {operand.kind === "literal" && <Input id={`${id}-number`} aria-label={`${label} number`} inputMode="decimal" disabled={disabled}
      value={String(operand.literal.value)} onChange={(event) => {
        const text = event.target.value.trim();
        onChange(/^-?\d+$/.test(text) && Number.isSafeInteger(Number(text))
          ? { kind: "literal", literal: { type: "whole_number", value: Number(text) } }
          : { kind: "literal", literal: { type: "decimal_number", value: text } });
      }} />}
  </div>;
}

export function StudioFlowCalculationControl({ id, value, references, disabled, onChange }: Readonly<{
  id: string;
  value: StudioFlowCalculation;
  references: readonly StudioFlowCalculationReference[];
  disabled: boolean;
  onChange: (value: StudioFlowCalculation) => void;
}>) {
  return <div className="space-y-2 border-l-2 border-border pl-3">
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${id}-operator`}>Operation</Label>
      <NativeSelect id={`${id}-operator`} className="w-full" disabled={disabled} value={value.operator}
        onChange={(event) => onChange({ ...value, operator: event.target.value as StudioFlowCalculation["operator"] })}>
        {operators.map((operator) => <NativeSelectOption key={operator.value} value={operator.value}>{operator.label}</NativeSelectOption>)}
      </NativeSelect>
    </div>
    <OperandControl id={`${id}-left`} label="First number" operand={value.left} references={references} disabled={disabled}
      onChange={(left) => onChange({ ...value, left })} />
    <OperandControl id={`${id}-right`} label="Second number" operand={value.right} references={references} disabled={disabled}
      onChange={(right) => onChange({ ...value, right })} />
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${id}-scale`}>Decimal places</Label>
      <Input id={`${id}-scale`} inputMode="numeric" disabled={disabled} value={String(value.scale)}
        onChange={(event) => onChange({ ...value, scale: Number(event.target.value) })} />
    </div>
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${id}-rounding`}>Rounding</Label>
      <NativeSelect id={`${id}-rounding`} className="w-full" disabled={disabled} value={value.rounding}
        onChange={(event) => onChange({ ...value, rounding: event.target.value as FlowRoundingMode })}>
        {flowRoundingModeSchema.options.map((mode) => <NativeSelectOption key={mode} value={mode}>
          {roundingLabels[mode] ?? mode.replace(/_/g, " ")}</NativeSelectOption>)}
      </NativeSelect>
    </div>
  </div>;
}
