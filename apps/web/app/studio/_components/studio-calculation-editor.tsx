"use client";
import { useMemo } from "react";
import {
  calculationForcedReadTime,
  calculationResultChoices,
  calculationResultTypeLabels,
  settledCalculation,
  typedDecimalPlaces,
  type CalculationSettings,
  type FlowFormula,
  type FormulaField,
  type ModuleField,
  type FlowLiteral,
  type FlowDateUnit,
  type FlowRoundingMode,
} from "@vortex/platform/schema";
import { StudioOptionControl, StudioReferencePicker } from "@vortex/ui/studio";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { Button } from "@vortex/ui/components/button";

const labels = {
  reference: "A field",
  literal: "A fixed value",
  add: "Add",
  subtract: "Subtract",
  multiply: "Multiply",
  divide: "Divide",
  round: "Round",
  eq: "Equals",
  neq: "Does not equal",
  lt: "Less than",
  lte: "At most",
  gt: "Greater than",
  gte: "At least",
  contains: "Contains",
  starts_with: "Starts with",
  ends_with: "Ends with",
  is_empty: "Is empty",
  is_not_empty: "Is filled in",
  in: "Is one of",
  and: "All conditions",
  or: "Any condition",
  not: "Not",
  if: "Choose by a condition",
  join: "Join text",
  date_add: "Move a date",
  date_diff: "Difference between dates",
  deadline_passed: "Whether a deadline has passed",
} as const;
type Operator = keyof typeof labels;
const fixed = (): FlowFormula => ({ op: "literal", type: "decimal_number", value: "1" });
const starter = (op: Operator, fields: readonly FormulaField[]): FlowFormula => {
  const reference: FlowFormula = {
    op: "reference",
    reference: { source: "trigger_record", field: fields[0]?.key ?? "" },
  };
  const yes: FlowFormula = { op: "literal", type: "yes_no", value: true };
  switch (op) {
    case "reference":
      return reference;
    case "literal":
      return fixed();
    case "add":
    case "multiply":
    case "subtract":
    case "divide":
      return { op, args: [reference, fixed()], scale: 2, rounding: "half_even" };
    case "round":
      return { op, arg: reference, scale: 2, rounding: "half_even" };
    case "is_empty":
    case "is_not_empty":
      return { op, arg: reference };
    case "not":
      return { op, arg: yes };
    case "and":
    case "or":
      return { op, args: [yes, yes] };
    case "in":
      return { op, value: reference, options: [{ op: "literal", type: "text", value: "" }] };
    case "if":
      return { op, condition: yes, then: reference, else: fixed() };
    case "join":
      return { op, parts: [reference], separator: " " };
    case "date_add":
      return {
        op,
        date: reference,
        amount: { op: "literal", type: "whole_number", value: 7 },
        unit: "days",
      };
    case "date_diff":
      return { op, from: reference, to: reference, unit: "days" };
    case "deadline_passed":
      return { op, due: reference, terminalStatusValues: [] };
    default:
      return { op, left: reference, right: { op: "literal", type: "text", value: "" } };
  }
};

/** Edits the actual FlowFormula tree; no intermediate calculation expression exists. */
function Formula({
  id,
  value,
  fields,
  disabled,
  onChange,
  depth = 1,
}: Readonly<{
  id: string;
  value: FlowFormula;
  fields: readonly FormulaField[];
  disabled: boolean;
  onChange: (value: FlowFormula) => void;
  depth?: number;
}>) {
  const part = (
    key: string,
    label: string,
    node: FlowFormula,
    change: (next: FlowFormula) => FlowFormula,
  ) => (
    <fieldset key={key} className="space-y-2 border-l pl-3">
      <legend className="text-sm font-medium">{label}</legend>
      <Formula
        id={`${id}-${key}`}
        value={node}
        fields={fields}
        disabled={disabled}
        depth={depth + 1}
        onChange={(next) => onChange(change(next))}
      />
    </fieldset>
  );
  const list = (
    key: "args" | "parts" | "options",
    entries: FlowFormula[],
    minimum: number,
    maximum: number,
  ) => {
    const change = (next: FlowFormula[]) => ({ ...value, [key]: next }) as FlowFormula;
    return (
      <div className="space-y-3">
        {entries.map((entry, index) => (
          <div key={index} className="space-y-1">
            {part(`${key}-${index}`, `Value ${index + 1}`, entry, (next) =>
              change(entries.map((item, at) => (at === index ? next : item))),
            )}
            {entries.length > minimum && (
              <Button
                type="button"
                variant="ghost"
                disabled={disabled}
                onClick={() => onChange(change(entries.filter((_, at) => at !== index)))}
              >
                Remove value {index + 1}
              </Button>
            )}
          </div>
        ))}
        {entries.length < maximum && (
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() => onChange(change([...entries, fixed()]))}
          >
            Add a value
          </Button>
        )}
      </div>
    );
  };
  const body = (() => {
    switch (value.op) {
      case "reference":
        return (
          <StudioReferencePicker
            id={`${id}-field`}
            value={value.reference.source === "trigger_record" ? value.reference.field : ""}
            unset="Choose a field"
            disabled={disabled}
            options={fields.map((field) => ({ value: field.key, label: field.label }))}
            onChange={(field) =>
              onChange({ op: "reference", reference: { source: "trigger_record", field } })
            }
          />
        );
      case "literal":
        return (
          <div className="space-y-2">
            <Label htmlFor={`${id}-type`}>Value type</Label>
            <StudioOptionControl
              id={`${id}-type`}
              disabled={disabled}
              value={value.type}
              options={Object.entries(calculationResultTypeLabels)
                .filter(([type]) => type !== "money")
                .map(([type, label]) => ({ value: type, label }))}
              onChange={(type) =>
                onChange({
                  op: "literal",
                  type: type as FlowLiteral["type"],
                  value:
                    type === "yes_no"
                      ? false
                      : type === "whole_number"
                        ? 0
                        : type === "decimal_number"
                          ? "0"
                          : "",
                })
              }
            />
            <Label htmlFor={`${id}-value`}>Fixed value</Label>
            {value.type === "yes_no" ? (
              <StudioOptionControl
                id={`${id}-value`}
                disabled={disabled}
                value={String(value.value)}
                options={[
                  { value: "true", label: "Yes" },
                  { value: "false", label: "No" },
                ]}
                onChange={(next) => onChange({ ...value, value: next === "true" })}
              />
            ) : (
              <Input
                id={`${id}-value`}
                disabled={disabled}
                value={String(value.value ?? "")}
                onChange={(event) =>
                  onChange({
                    ...value,
                    value:
                      value.type === "whole_number"
                        ? Number(event.target.value)
                        : event.target.value,
                  })
                }
              />
            )}
          </div>
        );
      case "now":
        return (
          <p className="text-sm text-muted-foreground">Worked out each time the record is read.</p>
        );
      case "join":
        return (
          <>
            {list("parts", value.parts, 1, 20)}
            <Label htmlFor={`${id}-separator`}>Between parts</Label>
            <Input
              id={`${id}-separator`}
              disabled={disabled}
              value={value.separator ?? ""}
              maxLength={20}
              onChange={(event) => onChange({ ...value, separator: event.target.value })}
            />
          </>
        );
      case "add":
      case "multiply":
      case "subtract":
      case "divide":
        return list("args", value.args, 2, value.op === "add" || value.op === "multiply" ? 10 : 2);
      case "and":
      case "or":
        return list("args", value.args, 2, 20);
      case "round":
      case "not":
      case "is_empty":
      case "is_not_empty":
      case "record_id":
        return part("arg", "Value", value.arg, (arg) => ({ ...value, arg }));
      case "in":
        return (
          <>
            {part("value", "This value", value.value, (next) => ({ ...value, value: next }))}
            {list("options", value.options, 1, 50)}
          </>
        );
      case "if":
        return (
          <>
            {part("condition", "When", value.condition, (condition) => ({ ...value, condition }))}
            {part("then", "Use when yes", value.then, (then) => ({ ...value, then }))}
            {part("else", "Use when no", value.else, (otherwise) => ({
              ...value,
              else: otherwise,
            }))}
          </>
        );
      case "date_add":
        return (
          <>
            {part("date", "Starting date", value.date, (date) => ({ ...value, date }))}
            {part("amount", "Add this many", value.amount, (amount) => ({ ...value, amount }))}
          </>
        );
      case "date_diff":
        return (
          <>
            {part("from", "From", value.from, (from) => ({ ...value, from }))}
            {part("to", "To", value.to, (to) => ({ ...value, to }))}
          </>
        );
      case "deadline_passed":
        return (
          <>
            {part("due", "Deadline", value.due, (due) => ({ ...value, due }))}
            <Label htmlFor={`${id}-status`}>Status field (optional)</Label>
            <StudioReferencePicker
              id={`${id}-status`}
              disabled={disabled}
              value={
                value.status?.op === "reference" &&
                value.status.reference.source === "trigger_record"
                  ? value.status.reference.field
                  : ""
              }
              unset="No status field"
              options={fields.map((field) => ({ value: field.key, label: field.label }))}
              onChange={(field) => {
                const { status: previous, ...rest } = value;
                void previous;
                onChange(
                  field === ""
                    ? { ...rest, terminalStatusValues: [] }
                    : {
                        ...rest,
                        status: { op: "reference", reference: { source: "trigger_record", field } },
                      },
                );
              }}
            />
            {value.status !== undefined && (
              <>
                <Label htmlFor={`${id}-terminal`}>Finished status values (one per line)</Label>
                <textarea
                  id={`${id}-terminal`}
                  className="flex min-h-20 w-full rounded-md border bg-transparent px-3 py-2 text-sm"
                  disabled={disabled}
                  value={value.terminalStatusValues.join("\n")}
                  onChange={(event) =>
                    onChange({
                      ...value,
                      terminalStatusValues: event.target.value
                        .split("\n")
                        .filter((entry) => entry !== ""),
                    })
                  }
                />
              </>
            )}
          </>
        );
      default:
        return (
          <>
            {part("left", "This value", value.left, (left) => ({ ...value, left }))}
            {part("right", "Compared with", value.right, (right) => ({ ...value, right }))}
          </>
        );
    }
  })();
  return (
    <div className="space-y-2">
      <Label htmlFor={`${id}-operation`}>Formula</Label>
      <StudioOptionControl
        id={`${id}-operation`}
        value={value.op}
        disabled={disabled}
        options={Object.entries(labels)
          .filter(([op]) => depth < 10 || op === "literal" || op === "reference" || op === "now")
          .map(([op, label]) => ({ value: op, label }))}
        onChange={(op) => onChange(starter(op as Operator, fields))}
      />
      {body}
      {"scale" in value && (
        <>
          <Label htmlFor={`${id}-scale`}>Operation decimal places</Label>
          <Input
            id={`${id}-scale`}
            type="number"
            min={0}
            max={18}
            disabled={disabled}
            value={value.scale}
            onChange={(event) => onChange({ ...value, scale: Number(event.target.value) })}
          />
          <Label htmlFor={`${id}-rounding`}>Rounding</Label>
          <StudioOptionControl
            id={`${id}-rounding`}
            disabled={disabled}
            value={value.rounding}
            options={["half_even", "half_up", "half_down", "up", "down", "ceiling", "floor"].map(
              (mode) => ({ value: mode, label: mode.replaceAll("_", " ") }),
            )}
            onChange={(rounding) => onChange({ ...value, rounding: rounding as FlowRoundingMode })}
          />
        </>
      )}
      {"unit" in value && (
        <>
          <Label htmlFor={`${id}-unit`}>Time unit</Label>
          <StudioOptionControl
            id={`${id}-unit`}
            disabled={disabled}
            value={value.unit}
            options={["minutes", "hours", "days", "weeks", "months", "years"].map((unit) => ({
              value: unit,
              label: unit,
            }))}
            onChange={(unit) => onChange({ ...value, unit: unit as FlowDateUnit })}
          />
        </>
      )}
    </div>
  );
}

export function StudioCalculationEditor({
  idPrefix,
  settings,
  fields,
  disabled,
  onChange,
}: Readonly<{
  idPrefix: string;
  settings: CalculationSettings;
  fields: readonly FormulaField[];
  compiled: readonly ModuleField[] | undefined;
  disabled: boolean;
  onChange: (settings: CalculationSettings, conditionValid: boolean) => void;
}>) {
  const byKey = useMemo(() => new Map(fields.map((field) => [field.key, field])), [fields]);
  const set = (next: Partial<CalculationSettings>) =>
    onChange(settledCalculation({ ...settings, ...next }, byKey), true);
  const results = calculationResultChoices(settings.expression, byKey);
  const forced = calculationForcedReadTime(settings.expression, byKey);
  return (
    <div className="space-y-4">
      <Formula
        id={idPrefix}
        value={settings.expression}
        fields={fields}
        disabled={disabled}
        onChange={(expression) => set({ expression })}
      />
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-result`}>{"Result"}</Label>
        <StudioOptionControl
          id={`${idPrefix}-result`}
          disabled={disabled}
          value={settings.result_type}
          options={(results.length ? results : [settings.result_type]).map((type) => ({
            value: type,
            label: calculationResultTypeLabels[type],
          }))}
          onChange={(result_type) =>
            set({ result_type: result_type as CalculationSettings["result_type"] })
          }
        />
      </div>
      {["decimal_number", "money"].includes(settings.result_type) && (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-places`}>{"Result decimal places"}</Label>
          <Input
            id={`${idPrefix}-places`}
            disabled={disabled}
            type="number"
            min={0}
            max={12}
            value={settings.decimal_places ?? ""}
            onChange={(event) => set({ decimal_places: typedDecimalPlaces(event.target.value) })}
          />
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-evaluation`}>{"When it is worked out"}</Label>
        <StudioOptionControl
          id={`${idPrefix}-evaluation`}
          disabled={disabled || forced}
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
