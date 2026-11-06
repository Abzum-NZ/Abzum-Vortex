"use client";

import type { ReactElement } from "react";
import { Checkbox } from "../components/checkbox";
import { Field, FieldLabel } from "../components/field";
import { Reasoned } from "../components/reasoned";
import { Switch } from "../components/switch";
import { setFieldChange } from "../flow-runtime/flow-cycle";
import type { BooleanInputPayload } from "./projected-data";
import {
  readControlSettings,
  resolveControlContext,
  type ControlRenderProps,
} from "./control-context";
import {
  describedBy,
  FieldHelpTooltip,
  FieldLabelText,
  FieldMessages,
  inactiveNote,
  useFieldFeedback,
  useFieldIds,
  useSeededState,
  fieldFocusLost,
} from "./field-parts";
import { useFormField, useFormFieldPublisher } from "./form-context";

export type BooleanInputProps = ControlRenderProps<BooleanInputPayload>;

/**
 * Checkbox or switch emitting only its declared `field_changed` event with a typed boolean.
 * Space toggles either variant once, and Enter toggles the switch. Its help is a tooltip on an
 * information icon beside the label; a control that is unavailable with a reason (projected
 * data) stays focusable and says the reason in a tooltip (`Reasoned`).
 */
export function BooleanInput(props: BooleanInputProps): ReactElement {
  const context = resolveControlContext<BooleanInputPayload>(props, [
    "field_changed",
    "field_focus_lost",
  ]);
  const settings = readControlSettings(props, context.location);
  const ids = useFieldIds(props.placementId);
  const fieldKey = settings.fieldKey();
  const publish = useFormFieldPublisher(fieldKey);
  const label = context.accessibleName ?? props.metadata.name;
  const help = settings.text("help_text");
  const required = settings.boolean("required");
  const variant = settings.choice<"checkbox" | "switch">("variant", "checkbox");
  const draftFeedback = useFieldFeedback(fieldKey);
  const disabled =
    context.inactive || settings.boolean("disabled") || draftFeedback?.disabled === true;
  const error = context.values?.error;
  const reason = disabled ? inactiveNote(context) : undefined;

  const [checked, setChecked] = useSeededState(context.values?.value ?? false);
  useFormField(fieldKey, props.placementId, checked, undefined, {
    label,
    required: false,
    refusal: draftFeedback?.hidden === true ? "hidden" : disabled ? "disabled" : undefined,
    set: (value, cause) =>
      typeof value !== "boolean"
        ? "invalid_value"
        : {
            value,
            apply: () => setChecked(value),
            emit: () => context.events?.field_changed?.(setFieldChange(cause, fieldKey, value)),
          },
  });

  const change = (next: boolean): void => {
    if (disabled) return;
    setChecked(next);
    publish(next);
    context.events?.field_changed?.({
      event: "field_changed",
      origin: "user",
      depth: 0,
      immediate: true,
      fieldKey,
      value: next,
    });
  };

  const described = describedBy(ids, help, error, undefined, draftFeedback);
  // A control with a reason is aria-disabled by `Reasoned` (a disabled control gets no hover or
  // focus, so it could not show why); one without a reason is disabled outright.
  const hardDisabled = disabled && reason === undefined;
  return (
    <Field
      orientation="horizontal"
      onBlur={(event) => {
        if (!disabled) fieldFocusLost(event, context.events?.field_focus_lost, fieldKey, checked);
      }}
      data-vortex-control="boolean-input"
      hidden={draftFeedback?.hidden === true}
      data-vortex-placement-id={props.placementId}
      data-vortex-field-key={fieldKey}
      data-vortex-variant={variant}
    >
      <Reasoned reason={reason}>
        {variant === "switch" ? (
          <Switch
            id={ids.control}
            checked={checked}
            onCheckedChange={change}
            disabled={hardDisabled}
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
            disabled={hardDisabled}
            required={required}
            aria-labelledby={ids.label}
            aria-invalid={error !== undefined}
            {...described}
          />
        )}
      </Reasoned>
      <FieldLabel id={ids.label} htmlFor={ids.control}>
        <FieldLabelText label={label} required={required} />
      </FieldLabel>
      {help === undefined ? null : <FieldHelpTooltip id={ids.help} help={help} label={label} />}
      <FieldMessages
        ids={ids}
        help={undefined}
        error={error}
        note={undefined}
        draftFeedback={draftFeedback}
      />
    </Field>
  );
}
