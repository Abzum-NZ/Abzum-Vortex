"use client";

import { useEffect, useRef, type ChangeEvent, type ReactElement } from "react";
import { moduleFieldValueV2Schemas } from "@vortex/contracts";
import { Field, FieldLabel } from "../components/field";
import { Input } from "../components/input";
import { Textarea } from "../components/textarea";
import type { TextInputPayload } from "./projected-data";
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

export type TextInputProps = ControlRenderProps<TextInputPayload>;

const INPUT_TYPES = ["text", "email", "password", "tel", "url"] as const;

/**
 * Single-line or multi-line text field. Emits only its declared `field_changed` event with a
 * typed string value and publishes that value to its enclosing form.
 */
export function TextInput(props: TextInputProps): ReactElement {
  const context = resolveControlContext<TextInputPayload>(props, ["field_changed"]);
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
  const inputRef = useRef<HTMLInputElement>(null);
  const draftFeedback = useFieldFeedback(fieldKey);
  const disabled =
    context.inactive || settings.boolean("disabled") || draftFeedback?.disabled === true;
  const note = inactiveNote(context);

  const [value, setValue] = useSeededState(context.values?.value ?? "");
  const invalidEmail =
    inputType === "email" &&
    (value !== "" || required) &&
    !moduleFieldValueV2Schemas.email_address.safeParse(value).success;
  const error = invalidEmail ? "Enter a valid email address." : context.values?.error;
  useFormField(
    fieldKey,
    props.placementId,
    inputType === "email" && !required && value === "" ? null : value,
  );

  // FormContainer disables native validation, so this field refuses an invalid local submit.
  useEffect(() => {
    if (inputType !== "email" || multiline) return;
    const input = inputRef.current;
    const form = input?.form;
    if (input === null || input === undefined || form === null || form === undefined) return;
    const refuseInvalidEmail = (event: Event): void => {
      const candidate = input.value;
      if (
        input.disabled ||
        (!required && candidate === "") ||
        moduleFieldValueV2Schemas.email_address.safeParse(candidate).success
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      input.focus();
    };
    form.addEventListener("submit", refuseInvalidEmail, true);
    return () => form.removeEventListener("submit", refuseInvalidEmail, true);
  }, [inputType, multiline, required]);

  const onChange = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (disabled || readOnly) return;
    const next = event.target.value;
    setValue(next);
    context.events?.field_changed?.({
      event: "field_changed",
      fieldKey,
      value: inputType === "email" && !required && next === "" ? null : next,
    });
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
    ...describedBy(ids, help, error, note, draftFeedback),
  };

  return (
    <Field
      data-vortex-control="text-input"
      hidden={draftFeedback?.hidden === true}
      data-vortex-placement-id={props.placementId}
      data-vortex-field-key={fieldKey}
    >
      <FieldLabel htmlFor={ids.control}>
        <FieldLabelText label={label} required={required} />
      </FieldLabel>
      {multiline ? <Textarea {...controlProps} /> : <Input {...controlProps} ref={inputRef} type={inputType} />}
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
