"use client";
import { createContext, useContext, useState, type ReactNode } from "react";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { Textarea } from "@vortex/ui/components/textarea";
import type { FlowFormula, FlowLiteral, FlowReference, FlowValue } from "@vortex/platform/schema";
import {
  StudioOptionControl,
  StudioReferencePicker,
  describeStudioFlowValue,
  studioFixedLiteral,
  studioFixedLiteralType,
  studioFlowReferenceToken,
  studioFlowValueOf,
  studioFlowValueSourceOf,
  studioWords,
  type StudioFlowReferenceChoice,
  type StudioFlowValueSource,
} from "@vortex/ui/studio";

/**
 * One flow value: where it comes from (a fixed value, or something the flow can read at this step)
 * and, for a fixed value, the value itself typed by what the setting expects. A value the control
 * does not build (a calculation, a built set of values) is shown and kept until another is chosen.
 */

type LiteralType = FlowLiteral["type"];

/** Nesting depth of built values: only the outermost set of parts is indented, never stacked. */
const BuiltDepth = createContext(0);

function BuiltParts({ children }: Readonly<{ children: ReactNode }>) {
  const depth = useContext(BuiltDepth);
  return (
    <BuiltDepth.Provider value={depth + 1}>
      <div className={depth === 0 ? "space-y-3 border-l pl-3" : "space-y-3"}>{children}</div>
    </BuiltDepth.Provider>
  );
}

/** Structured values recurse through the same value control and reference picker as a single value. */
function BuiltValue({
  id,
  value,
  valueType,
  references,
  disabled,
  onChange,
}: Readonly<{
  id: string;
  value: FlowValue;
  /** What the whole value must be, which a chosen branch's value must be too. */
  valueType: string | undefined;
  references: readonly StudioFlowReferenceChoice[];
  disabled: boolean;
  onChange: (value: FlowValue) => void;
}>) {
  const child = (
    key: string,
    label: string,
    entry: FlowValue,
    change: (value: FlowValue) => void,
    partType?: string,
  ) => (
    <StudioFlowValueControl
      key={key}
      id={`${id}-part-${key}`}
      label={label}
      value={studioFlowValueSourceOf(entry)}
      valueType={partType}
      references={references}
      disabled={disabled}
      onChange={(next) => {
        if (next !== null) change(studioFlowValueOf(next));
      }}
    />
  );
  if (value.kind === "map")
    return (
      <BuiltParts>
        {Object.entries(value.entries).map(([key, entry]) =>
          child(key, studioWords(key), entry, (next) =>
            onChange({ ...value, entries: { ...value.entries, [key]: next } }),
          ),
        )}
      </BuiltParts>
    );
  if (value.kind === "array")
    return (
      <BuiltParts>
        {value.items.map((entry, index) =>
          child(String(index), `Item ${index + 1}`, entry, (next) =>
            onChange({
              ...value,
              items: value.items.map((item, at) => (at === index ? next : item)),
            }),
          ),
        )}
      </BuiltParts>
    );
  if (value.kind !== "formula") return null;
  const formula = value.formula;
  const part = (
    key: string,
    label: string,
    entry: FlowFormula,
    change: (next: FlowFormula) => FlowFormula,
    partType?: string,
  ) =>
    child(
      key,
      label,
      entry.op === "literal"
        ? { kind: "literal", literal: { type: entry.type, value: entry.value } }
        : entry.op === "reference"
          ? { kind: "reference", reference: entry.reference }
          : { kind: "formula", formula: entry },
      (next) => {
        if (next.kind === "formula") onChange({ kind: "formula", formula: change(next.formula) });
        else if (next.kind === "reference")
          onChange({
            kind: "formula",
            formula: change({ op: "reference", reference: next.reference }),
          });
        else if (next.kind === "literal")
          onChange({ kind: "formula", formula: change({ op: "literal", ...next.literal }) });
      },
      partType,
    );
  switch (formula.op) {
    case "now":
      return (
        <p className="text-sm text-muted-foreground">The date and time when this flow runs.</p>
      );
    case "join":
      return (
        <BuiltParts>
          {formula.parts.map((entry, index) =>
            part(String(index), `Text part ${index + 1}`, entry, (next) => ({
              ...formula,
              parts: formula.parts.map((item, at) => (at === index ? next : item)),
            })),
          )}
          <Label htmlFor={`${id}-separator`}>Between parts</Label>
          <Input
            id={`${id}-separator`}
            disabled={disabled}
            maxLength={20}
            value={formula.separator ?? ""}
            onChange={(event) =>
              onChange({ kind: "formula", formula: { ...formula, separator: event.target.value } })
            }
          />
        </BuiltParts>
      );
    case "if":
      return (
        <BuiltParts>
          {part(
            "condition",
            "When",
            formula.condition,
            (condition) => ({ ...formula, condition }),
            "yes_no",
          )}
          {part(
            "then",
            "Use this when yes",
            formula.then,
            (then) => ({ ...formula, then }),
            valueType,
          )}
          {part(
            "else",
            "Use this when no",
            formula.else,
            (otherwise) => ({ ...formula, else: otherwise }),
            valueType,
          )}
        </BuiltParts>
      );
    case "record_id":
    case "is_empty":
    case "is_not_empty":
      return (
        <BuiltParts>
          {part(
            "value",
            formula.op === "record_id" ? "Take the record from" : "Check this value",
            formula.arg,
            (arg) => ({ ...formula, arg }),
          )}
        </BuiltParts>
      );
    case "gt":
      return (
        <BuiltParts>
          {part("left", "This value", formula.left, (left) => ({ ...formula, left }))}
          {part("right", "Is greater than", formula.right, (right) => ({ ...formula, right }))}
        </BuiltParts>
      );
    case "date_add":
      return (
        <BuiltParts>
          {part(
            "date",
            "Starting date",
            formula.date,
            (date) => ({ ...formula, date }),
            formula.date.op === "literal" && formula.date.type === "date" ? "date" : "date_time",
          )}
          {part(
            "amount",
            "Add this many",
            formula.amount,
            (amount) => ({ ...formula, amount }),
            "whole_number",
          )}
          <Label htmlFor={`${id}-unit`}>Time unit</Label>
          <StudioOptionControl
            id={`${id}-unit`}
            disabled={disabled}
            value={formula.unit}
            options={(["minutes", "hours", "days", "weeks", "months", "years"] as const).map(
              (unit) => ({ value: unit, label: studioWords(unit) }),
            )}
            onChange={(unit) =>
              onChange({
                kind: "formula",
                formula: { ...formula, unit: unit as typeof formula.unit },
              })
            }
          />
        </BuiltParts>
      );
    case "literal":
      return child(
        "value",
        "Value",
        { kind: "literal", literal: { type: formula.type, value: formula.value } },
        onChange,
        formula.type,
      );
    case "reference":
      return child(
        "value",
        "Value",
        { kind: "reference", reference: formula.reference },
        onChange,
        valueType,
      );
    default:
      return (
        <p className="text-sm">
          This calculation is defined in Import from source in the Releases tab.
        </p>
      );
  }
}

/** A fixed value's starting literal for a type. */
const startLiteral = (
  type: LiteralType,
  options: readonly Readonly<{ value: string }>[],
): FlowLiteral =>
  type === "yes_no"
    ? { type, value: false }
    : type === "whole_number"
      ? { type, value: 0 }
      : type === "several_choices"
        ? { type, value: [] }
        : type === "choice" && options[0] !== undefined
          ? { type, value: options[0].value }
          : { type, value: "" };

const literalText = (literal: FlowLiteral): string =>
  Array.isArray(literal.value)
    ? literal.value.join(", ")
    : typeof literal.value === "string"
      ? literal.value
      : literal.value === null
        ? ""
        : String(literal.value);

function FixedInput({
  id,
  label,
  literal,
  options,
  long,
  disabled,
  onChange,
}: Readonly<{
  id: string;
  label: string;
  literal: FlowLiteral;
  options: readonly Readonly<{ value: string; label: string }>[];
  long: boolean;
  disabled: boolean;
  onChange: (literal: FlowLiteral) => void;
}>) {
  const current = literalText(literal);
  const [draft, setDraft] = useState(current);
  const [seen, setSeen] = useState(current);
  if (current !== seen) {
    setSeen(current);
    setDraft(current);
  }
  if (literal.type === "yes_no")
    return (
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          disabled={disabled}
          checked={literal.value === true}
          onCheckedChange={(checked) => onChange({ type: "yes_no", value: checked === true })}
        />
        <Label htmlFor={id}>Yes</Label>
      </div>
    );
  if (literal.type === "choice" && options.length > 0)
    return (
      <StudioOptionControl
        id={id}
        aria-label={`${label} value`}
        disabled={disabled}
        value={current}
        options={options}
        onChange={(next) => onChange({ type: "choice", value: next })}
      />
    );
  const change = (text: string) => {
    setDraft(text);
    const built = studioFixedLiteral(literal.type, text, "value");
    // A value that does not fit its type is kept as typed; the step refuses it, saying where it is.
    onChange(built.ok ? built.literal : { type: literal.type, value: text });
  };
  const hint =
    literal.type === "date"
      ? "2026-01-31"
      : literal.type === "date_time"
        ? "2026-01-31T09:30:00Z"
        : literal.type === "several_choices"
          ? "first, second"
          : undefined;
  return long ? (
    <Textarea
      id={id}
      aria-label={`${label} value`}
      disabled={disabled}
      maxLength={2_000}
      value={draft}
      onChange={(event) => change(event.target.value)}
    />
  ) : (
    <Input
      id={id}
      aria-label={`${label} value`}
      disabled={disabled}
      value={draft}
      placeholder={hint}
      inputMode={
        literal.type === "whole_number" || literal.type === "decimal_number" ? "decimal" : undefined
      }
      onChange={(event) => change(event.target.value)}
    />
  );
}

export function StudioFlowValueControl({
  id,
  label,
  value,
  valueType,
  options = [],
  references,
  referenceCompatible,
  unset,
  long = false,
  disabled,
  onChange,
  optional = false,
}: Readonly<{
  optional?: boolean;
  id: string;
  label: string;
  value: StudioFlowValueSource | null;
  /** What the setting expects; undefined accepts any value. */
  valueType: string | undefined;
  /** The options of a choice, when the value sets one. */
  options?: readonly Readonly<{ value: string; label: string }>[];
  references: readonly StudioFlowReferenceChoice[];
  /** Field-aware compatibility, when the owning contract supplies it. */
  referenceCompatible?: (reference: FlowReference) => boolean;
  /** The words for leaving it unset, when it may be left unset. */
  unset?: string;
  long?: boolean;
  disabled: boolean;
  onChange: (value: StudioFlowValueSource | null) => void;
}>) {
  const fixedType = options.length > 0 ? "choice" : studioFixedLiteralType(valueType);
  const offered = references.filter((choice) =>
    referenceCompatible !== undefined
      ? referenceCompatible(choice.reference)
      : valueType === undefined ||
        choice.type === undefined ||
        choice.type === "json" ||
        choice.type === valueType ||
        (valueType === "text" && (choice.type === "choice" || choice.type === "formatted_text")) ||
        (valueType === "choice" && choice.type === "text") ||
        valueType === "json",
  );
  const token =
    value === null
      ? ""
      : value.kind === "fixed"
        ? "fixed"
        : value.kind === "kept" || value.kind === "built"
          ? value.kind
          : studioFlowReferenceToken(value.reference);
  const known =
    token === "" ||
    token === "fixed" ||
    token === "kept" ||
    token === "built" ||
    offered.some((choice) => choice.token === token);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={`${id}-from`}>
        {label}
        {optional && <span className="text-xs text-muted-foreground">Optional</span>}
      </Label>
      <StudioReferencePicker
        id={`${id}-from`}
        disabled={disabled}
        value={token}
        aria-invalid={!known}
        unset={unset ?? (value === null ? "Choose where it comes from?" : undefined)}
        options={[
          ...(fixedType === undefined ? [] : [{ value: "fixed", label: "A fixed value" }]),
          ...(value?.kind === "kept"
            ? [
                {
                  value: "kept",
                  label: describeStudioFlowValue(value, references),
                  description: "Change this calculation in Import from source in the Releases tab",
                  disabled: true,
                },
              ]
            : []),
          ...(value?.kind === "built"
            ? [
                {
                  value: "built",
                  label:
                    value.value.kind === "map"
                      ? "A set of named values"
                      : value.value.kind === "array"
                        ? "A list of values"
                        : value.value.kind === "formula" && value.value.formula.op === "join"
                          ? "Text assembled from values"
                          : value.value.kind === "formula" && value.value.formula.op === "if"
                            ? "A value chosen by a condition"
                            : value.value.kind === "formula" &&
                                value.value.formula.op === "is_empty"
                              ? "Whether a value is empty"
                              : value.value.kind === "formula" &&
                                  value.value.formula.op === "is_not_empty"
                                ? "Whether a value is filled in"
                                : "A calculated value",
                },
              ]
            : []),
          ...offered.map((choice) => ({
            value: choice.token,
            label: choice.label,
            group: choice.group,
          })),
          ...(!known
            ? [{ value: token, label: "A value this step can no longer read", disabled: true }]
            : []),
        ]}
        onChange={(next) => {
          if (next === "") onChange(null);
          else if (next === "fixed" && fixedType !== undefined)
            onChange({ kind: "fixed", literal: startLiteral(fixedType, options) });
          else {
            const choice = offered.find((entry) => entry.token === next);
            if (choice !== undefined) onChange({ kind: "reference", reference: choice.reference });
          }
        }}
      />
      {value?.kind === "fixed" && (
        <FixedInput
          id={id}
          label={label}
          literal={value.literal}
          options={options}
          long={long}
          disabled={disabled}
          onChange={(literal) => onChange({ kind: "fixed", literal })}
        />
      )}
      {value?.kind === "built" && (
        <BuiltValue
          id={id}
          value={value.value}
          valueType={valueType}
          references={references}
          disabled={disabled}
          onChange={(next) => onChange(studioFlowValueSourceOf(next))}
        />
      )}
      {!known && (
        <p role="alert" className="text-sm text-destructive">
          This step cannot read that value here any more. Choose another.
        </p>
      )}
    </div>
  );
}
