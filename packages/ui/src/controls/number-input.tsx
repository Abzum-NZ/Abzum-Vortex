"use client";

import type { ChangeEvent, ReactElement } from "react";
import {
  compareExactDecimals,
  formatExactDecimal,
  parseExactDecimal,
  powerOfTen,
} from "@vortex/platform/schema";
import { Field, FieldLabel } from "../components/field";
import { Input } from "../components/input";
import { DefinitionRenderError } from "../definition-error";
import type { NumberInputPayload } from "./projected-data";
import {
  readControlSettings,
  resolveControlContext,
  type ControlRenderProps,
} from "./control-context";
import {
  describedBy,
  FieldLabelText,
  FieldMessages,
  inactiveNote,
  useFieldFeedback,
  useFieldIds,
  useSeededState,
  fieldFocusLost,
} from "./field-parts";
import { useFormField, useFormFieldError } from "./form-context";

export type NumberInputProps = ControlRenderProps<NumberInputPayload>;

// Settings are numbers in the existing control contract and may stringify in exponent notation.
const settingDecimal = (setting: number) => {
  const [mantissa, exponentText] = String(setting).split("e");
  if (exponentText === undefined) return parseExactDecimal(mantissa);
  const negative = mantissa!.startsWith("-");
  const digits = mantissa!.replace("-", "").replace(".", "");
  const point =
    (mantissa!.replace("-", "").indexOf(".") < 0
      ? digits.length
      : mantissa!.replace("-", "").indexOf(".")) + Number(exponentText);
  const magnitude =
    point <= 0
      ? `0.${"0".repeat(-point)}${digits}`
      : point >= digits.length
        ? digits + "0".repeat(point - digits.length)
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return parseExactDecimal(`${negative ? "-" : ""}${magnitude}`);
};

/**
 * Number input. Decimal fields retain their exact entered text through submit; integer fields
 * publish a safe integer. Empty or invalid entry is `null`.
 */
export function NumberInput(props: NumberInputProps): ReactElement {
  const context = resolveControlContext<NumberInputPayload>(props, [
    "field_changed",
    "field_focus_lost",
  ]);
  const settings = readControlSettings(props, context.location);
  const ids = useFieldIds();
  const fieldKey = settings.fieldKey();
  const label = context.accessibleName ?? props.metadata.name;
  const help = settings.text("help_text");
  const placeholder = settings.text("placeholder");
  const required = settings.boolean("required");
  const readOnly = settings.boolean("read_only");
  const integer = settings.boolean("integer");
  const minimum = settings.number("min_value");
  const maximum = settings.number("max_value");
  const step = settings.number("step_value");
  if (minimum !== undefined && maximum !== undefined && maximum < minimum)
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      "A number input maximum cannot be below its minimum",
      { ...context.location, propertyPath: ["max_value"] },
    );
  if (step !== undefined && !(step > 0))
    throw new DefinitionRenderError("INVALID_COMPOSITION", "A number input step must be positive", {
      ...context.location,
      propertyPath: ["step_value"],
    });
  const draftFeedback = useFieldFeedback(fieldKey);
  const disabled =
    context.inactive || settings.boolean("disabled") || draftFeedback?.disabled === true;
  const projectedError = context.values?.error;
  const note = inactiveNote(context);

  const projected = context.values?.value;
  const [raw, setRaw] = useSeededState(
    projected === undefined || projected === null ? "" : String(projected),
  );
  const decimalSeparator =
    new Intl.NumberFormat().formatToParts(1.1).find((part) => part.type === "decimal")?.value ??
    ".";
  const toTyped = (text: string): string | number | null => {
    const canonical = decimalSeparator === "." ? text : text.replace(decimalSeparator, ".");
    const parsed = parseExactDecimal(canonical);
    if (parsed === undefined) return null;
    if (integer) {
      if (parsed.scale !== 0) return null;
      const whole = Number(parsed.coefficient);
      return Number.isSafeInteger(whole) ? whole : null;
    }
    return formatExactDecimal(parsed);
  };
  const typed = toTyped(raw);
  const validate = (): string | undefined => {
    if (disabled || readOnly) return undefined;
    if (raw.trim() === "") return required ? `${label} is required.` : undefined;
    if (typed === null) return `${label}: enter a valid ${integer ? "whole number" : "number"}.`;
    const exact = parseExactDecimal(String(typed))!;
    const minimumExact = minimum === undefined ? undefined : settingDecimal(minimum);
    const maximumExact = maximum === undefined ? undefined : settingDecimal(maximum);
    if (minimumExact !== undefined && compareExactDecimals(exact, minimumExact) < 0)
      return `${label}: enter a value of at least ${minimum}.`;
    if (maximumExact !== undefined && compareExactDecimals(exact, maximumExact) > 0)
      return `${label}: enter a value of at most ${maximum}.`;
    const stepExact = step === undefined ? undefined : settingDecimal(step);
    if (stepExact !== undefined) {
      const base = minimumExact ?? parseExactDecimal("0")!;
      const scale = Math.max(exact.scale, base.scale, stepExact.scale);
      const scaled = (value: typeof exact) => value.coefficient * powerOfTen(scale - value.scale);
      if ((scaled(exact) - scaled(base)) % scaled(stepExact) !== 0n)
        return `${label}: enter a value in increments of ${step}.`;
    }
    return undefined;
  };
  useFormField(fieldKey, props.placementId, typed, validate);
  const validationError = useFormFieldError(fieldKey);
  const error = projectedError ?? validationError ?? (raw.trim() === "" ? undefined : validate());

  const onChange = (event: ChangeEvent<HTMLInputElement>): void => {
    if (disabled || readOnly) return;
    const next = event.target.value;
    setRaw(next);
    context.events?.field_changed?.({
      event: "field_changed",
      origin: "user",
      depth: 0,
      immediate: false,
      fieldKey,
      value: toTyped(next),
    });
  };

  return (
    <Field
      onBlur={(event) => {
        if (!disabled && !readOnly)
          fieldFocusLost(event, context.events?.field_focus_lost, fieldKey, typed);
      }}
      data-vortex-control="number-input"
      hidden={draftFeedback?.hidden === true}
      data-vortex-placement-id={props.placementId}
      data-vortex-field-key={fieldKey}
    >
      <FieldLabel htmlFor={ids.control}>
        <FieldLabelText label={label} required={required} />
      </FieldLabel>
      <Input
        id={ids.control}
        type="text"
        inputMode={integer ? "numeric" : "decimal"}
        name={fieldKey}
        value={raw}
        onChange={onChange}
        disabled={disabled}
        readOnly={readOnly}
        required={required}
        {...(placeholder === undefined ? {} : { placeholder })}
        {...(minimum === undefined ? {} : { min: minimum })}
        {...(maximum === undefined ? {} : { max: maximum })}
        step={step ?? (integer ? 1 : "any")}
        aria-invalid={error !== undefined}
        {...describedBy(ids, help, error, note, draftFeedback)}
      />
      <FieldMessages
        ids={ids}
        help={help}
        error={error}
        note={note}
        draftFeedback={draftFeedback}
      />
    </Field>
  );
}
