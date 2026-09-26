"use client";

import type { ReactElement } from "react";
import { Checkbox } from "../components/checkbox";
import { Field, FieldLabel } from "../components/field";
import { Switch } from "../components/switch";
import type { BooleanInputPayload } from "./projected-data";
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
} from "./field-parts";
import { useFormField } from "./form-context";

export type BooleanInputProps = ControlRenderProps<BooleanInputPayload>;

/**
 * Checkbox or switch emitting only its declared `field_changed` event with a typed boolean.
 * Space toggles either variant once, and Enter toggles the switch.
 */
export function BooleanInput(props: BooleanInputProps): ReactElement {
  const context = resolveControlContext<BooleanInputPayload>(props, ["field_changed"]);
  const settings = readControlSettings(props, context.location);
  const ids = useFieldIds();
  const fieldKey = settings.fieldKey();
  const label = context.accessibleName ?? props.metadata.name;
  const help = settings.text("help_text");
  const required = settings.boolean("required");
  const variant = settings.choice<"checkbox" | "switch">("variant", "checkbox");
  const draftFeedback = useFieldFeedback(fieldKey);
  const disabled =
    context.inactive || settings.boolean("disabled") || draftFeedback?.disabled === true;
  const error = context.values?.error;
  const note = inactiveNote(context);

  const [checked, setChecked] = useSeededState(context.values?.value ?? false);
  useFormField(fieldKey, props.placementId, checked);

  const change = (next: boolean): void => {
    if (disabled) return;
    setChecked(next);
    context.events?.field_changed?.({ event: "field_changed", fieldKey, value: next });
  };

  const described = describedBy(ids, help, error, note, draftFeedback);
  return (
    <Field
      orientation="horizontal"
      data-vortex-control="boolean-input"
      hidden={draftFeedback?.hidden === true}
      data-vortex-placement-id={props.placementId}
      data-vortex-field-key={fieldKey}
      data-vortex-variant={variant}
    >
      {variant === "switch" ? (
        <Switch
          id={ids.control}
          checked={checked}
          onCheckedChange={change}
          disabled={disabled}
          aria-labelledby={ids.label}
          aria-invalid={error !== undefined}
          {...described}
        />
      ) : (
        <Checkbox
          id={ids.control}
          name={fieldKey}
          checked={checked}
          onCheckedChange={change}
          disabled={disabled}
          required={required}
          aria-labelledby={ids.label}
          aria-invalid={error !== undefined}
          {...described}
        />
      )}
      <FieldLabel id={ids.label} htmlFor={ids.control}>
        <FieldLabelText label={label} required={required} />
      </FieldLabel>
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
