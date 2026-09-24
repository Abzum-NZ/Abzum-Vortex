"use client";

import type { ChangeEvent, ReactElement } from "react";
import { DefinitionRenderError } from "../definition-error";
import type { PlatformBlockRenderProps } from "../registry";
import { readControlSettings, resolveControlContext } from "./control-context";
import {
  describedBy,
  FieldLabelText,
  FieldMessages,
  inactiveNote,
  useFieldFeedback,
  useFieldIds,
  useSeededState,
} from "./field-parts";
import { useFormField } from "./form-context";

export type NumberInputProps = PlatformBlockRenderProps;

/**
 * Typed number input. Empty, unparsable or non-integer (when integer is declared) entry is the
 * typed value `null`; it is never truncated or coerced. Arrow-key stepping is the native control's.
 */
export function NumberInput(props: NumberInputProps): ReactElement {
  const context = resolveControlContext(props, "number_input", ["field_changed"]);
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
  const error = context.values?.error;
  const note = inactiveNote(context);

  const projected = context.values?.value;
  const [raw, setRaw] = useSeededState(
    projected === undefined || projected === null ? "" : String(projected),
  );
  const toTyped = (text: string): number | null => {
    if (text.trim().length === 0) return null;
    const parsed = Number(text);
    if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) return null;
    return parsed;
  };
  useFormField(fieldKey, props.placementId, toTyped(raw));

  const onChange = (event: ChangeEvent<HTMLInputElement>): void => {
    if (disabled || readOnly) return;
    const next = event.target.value;
    setRaw(next);
    context.events?.field_changed?.({ event: "field_changed", fieldKey, value: toTyped(next) });
  };

  return (
    <div
      data-vortex-control="number-input"
      hidden={draftFeedback?.hidden === true}
      data-vortex-placement-id={props.placementId}
      data-vortex-field-key={fieldKey}
      className="vortex-field"
    >
      <label htmlFor={ids.control} className="vortex-field-label">
        <FieldLabelText label={label} required={required} />
      </label>
      <input
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
        className="vortex-input"
      />
      <FieldMessages
        ids={ids}
        help={help}
        error={error}
        note={note}
        draftFeedback={draftFeedback}
      />
    </div>
  );
}
