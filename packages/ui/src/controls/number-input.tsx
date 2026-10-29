"use client";

import type { ChangeEvent, ReactElement } from "react";
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
import { useRequiredFormField } from "./form-context";

export type NumberInputProps = ControlRenderProps<NumberInputPayload>;

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
  const toTyped = (text: string): string | number | null => {
    if (text.trim().length === 0) return null;
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) return null;
    if (integer) return Number.isSafeInteger(parsed) ? parsed : null;
    return text;
  };
  const typed = toTyped(raw);
  const validationError = useRequiredFormField(fieldKey, props.placementId, typed, {
    label,
    missing: required && !disabled && !readOnly && raw.trim() === "",
  });
  const error = projectedError ?? validationError;

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
        type="number"
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
