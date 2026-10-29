"use client";

import { useMemo } from "react";
import {
  calculationForcedReadTime,
  calculationResultChoices,
  calculationResultTypeLabels,
  flowRoundingModeSchema,
  settledCalculation,
  typedDecimalPlaces,
  type CalculationSettings,
  type FormulaField,
  type ModuleField,
} from "@vortex/platform/schema";
import { StudioOptionControl, studioFieldValueType, studioWords } from "@vortex/ui/studio";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { StudioFormulaEditor } from "./studio-formula-editor";

export function StudioCalculationEditor({
  idPrefix,
  settings,
  fields,
  disabled,
  shapeLocked,
  onChange,
}: Readonly<{
  idPrefix: string;
  settings: CalculationSettings;
  fields: readonly FormulaField[];
  compiled: readonly ModuleField[] | undefined;
  disabled: boolean;
  shapeLocked: boolean;
  onChange: (settings: CalculationSettings, conditionValid: boolean) => void;
}>) {
  const byKey = useMemo(() => new Map(fields.map((field) => [field.key, field])), [fields]);
  const set = (next: Partial<CalculationSettings>) =>
    onChange(
      shapeLocked ? { ...settings, ...next } : settledCalculation({ ...settings, ...next }, byKey),
      true,
    );
  const results = calculationResultChoices(settings.expression, byKey);
  const forced = calculationForcedReadTime(settings.expression, byKey);
  const references = fields.map((field) => {
    const nested = field.settings as { result_type?: string; resultType?: string } | undefined;
    const type =
      field.type === "calculation" || field.type === "total"
        ? (nested?.result_type ?? nested?.resultType)
        : field.type;
    return {
      name: field.key,
      label: field.label,
      type: studioFieldValueType(type ?? ""),
      reference: { source: "trigger_record" as const, field: field.key },
    };
  });
  return (
    <div className="space-y-4">
      <Label htmlFor={idPrefix}>Formula</Label>
      <StudioFormulaEditor
        id={idPrefix}
        value={settings.expression}
        references={references}
        disabled={disabled}
        onChange={(expression) => {
          if (expression === undefined) onChange(settings, false);
          else set({ expression });
        }}
      />
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-result`}>Result</Label>
        <StudioOptionControl
          id={`${idPrefix}-result`}
          disabled={disabled || shapeLocked}
          value={settings.result_type}
          options={(shapeLocked
            ? [settings.result_type]
            : results.length
              ? results
              : [settings.result_type]
          ).map((type) => ({
            value: type,
            label: calculationResultTypeLabels[type],
          }))}
          onChange={(result_type) =>
            set({ result_type: result_type as CalculationSettings["result_type"] })
          }
        />
      </div>
      {["decimal_number", "money"].includes(settings.result_type) && (
        <>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-places`}>Result decimal places</Label>
            <Input
              id={`${idPrefix}-places`}
              disabled={disabled || shapeLocked}
              type="number"
              min={0}
              max={12}
              value={settings.decimal_places ?? ""}
              onChange={(event) => set({ decimal_places: typedDecimalPlaces(event.target.value) })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-rounding`}>Rounding</Label>
            <StudioOptionControl
              id={`${idPrefix}-rounding`}
              disabled={disabled}
              value={settings.rounding ?? ""}
              options={flowRoundingModeSchema.options.map((mode) => ({
                value: mode,
                label: studioWords(mode),
              }))}
              onChange={(rounding) =>
                set({ rounding: rounding as CalculationSettings["rounding"] })
              }
            />
          </div>
        </>
      )}
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-evaluation`}>When it is worked out</Label>
        <StudioOptionControl
          id={`${idPrefix}-evaluation`}
          disabled={disabled || shapeLocked || forced}
          value={settings.evaluation ?? "stored"}
          options={[
            { value: "stored", label: "When saved" },
            { value: "read_time", label: "Each time it is read" },
          ]}
          onChange={(evaluation) => set({ evaluation: evaluation as "stored" | "read_time" })}
        />
      </div>
    </div>
  );
}
