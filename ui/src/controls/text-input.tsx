"use client";

import type { ChangeEvent, ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import { readControlSettings, resolveControlContext } from "./control-context";
import {
  describedBy,
  FieldLabelText,
  FieldMessages,
  inactiveNote,
  useFieldIds,
  useSeededState,
} from "./field-parts";
import { useFormField } from "./form-context";

export type TextInputProps = PlatformBlockRenderProps;

const INPUT_TYPES = ["text", "email", "password", "tel", "url"] as const;

/**
 * Single-line or multi-line text field. Emits only its declared `field_changed` event with a
 * typed string value and publishes that value to its enclosing form.
 */
export function TextInput(props: TextInputProps): ReactElement {
  const context = resolveControlContext(props, "text_input", ["field_changed"]);
  const settings = readControlSettings(props, context.location);
  const ids = useFieldIds();
  const fieldKey = settings.fieldKey();
  const label = context.accessibleName ?? props.metadata.name;
  const help = settings.text("help_text");
  const placeholder = settings.text("placeholder");
  const required = settings.boolean("required");
  const readOnly = settings.boolean("read_only");
  const multiline = settings.boolean("multiline");
  const inputType = settings.choice<(typeof INPUT_TYPES)[number]>("input_type", "text");
  const disabled = context.inactive || settings.boolean("disabled");
  const error = context.values?.error;
  const note = inactiveNote(context);

  const [value, setValue] = useSeededState(context.values?.value ?? "");
  useFormField(fieldKey, props.placementId, value);

  const onChange = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (disabled || readOnly) return;
    const next = event.target.value;
    setValue(next);
    context.events?.field_changed?.({ event: "field_changed", fieldKey, value: next });
  };

  const controlProps = {
    id: ids.control,
    name: fieldKey,
    value,
    onChange,
    disabled,
    readOnly,
    required,
    ...(placeholder === undefined ? {} : { placeholder }),
    "aria-invalid": error !== undefined,
    ...describedBy(ids, help, error, note),
  };

  return (
    <div
      data-vortex-control="text-input"
      data-vortex-placement-id={props.placementId}
      data-vortex-field-key={fieldKey}
      className="vortex-field"
    >
      <label htmlFor={ids.control} className="vortex-field-label">
        <FieldLabelText label={label} required={required} />
      </label>
      {multiline ? (
        <textarea {...controlProps} className="vortex-textarea" />
      ) : (
        <input {...controlProps} type={inputType} className="vortex-input" />
      )}
      <FieldMessages ids={ids} help={help} error={error} note={note} />
    </div>
  );
}
