"use client";

import { useEffect, useState, type ChangeEvent, type ReactElement } from "react";
import { Field, FieldLabel } from "../components/field";
import { Input } from "../components/input";
import type { DateTimeInputPayload } from "./projected-data";
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
import { formatterFor, toLocalInputValue, toStoredInstant } from "./date-time-zone";

type DateTimeInputProps = ControlRenderProps<DateTimeInputPayload>;

/**
 * Collects a time-zone-aware instant using the field's declared display policy. The browser
 * resolves the person's fallback zone after hydration when no profile zone is stored.
 */
export function DateTimeInput(props: DateTimeInputProps): ReactElement {
  const context = resolveControlContext<DateTimeInputPayload>(props, [
    "field_changed",
    "field_focus_lost",
  ]);
  const settings = readControlSettings(props, context.location);
  const [browserTimeZone, setBrowserTimeZone] = useState<string>();
  useEffect(() => {
    setBrowserTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);
  const ids = useFieldIds();
  const fieldKey = settings.fieldKey();
  const label = context.accessibleName ?? props.metadata.name;
  const authoredHelp = settings.text("help_text");
  const required = settings.boolean("required");
  const readOnly = settings.boolean("read_only");
  const draftFeedback = useFieldFeedback(fieldKey);
  const disabled =
    context.inactive || settings.boolean("disabled") || draftFeedback?.disabled === true;
  const projectedError = context.values?.error;
  const note = inactiveNote(context);
  const timeZonePolicy = settings.choice<"person" | "organization" | "utc">(
    "display_time_zone",
    "utc",
  );
  const timeZone =
    timeZonePolicy === "person"
      ? (context.values?.personTimeZone ?? browserTimeZone ?? "UTC")
      : timeZonePolicy === "organization"
        ? (context.values?.organizationTimeZone ?? "UTC")
        : "UTC";
  // A malformed supplied zone must never reinterpret a person's input as UTC.
  formatterFor(timeZone);
  const help = [authoredHelp, `Time zone: ${timeZone}.`].filter(Boolean).join(" ");
  const projected = context.values?.value ?? null;
  const initialInput = toLocalInputValue(projected, timeZone);
  const [raw, setRaw] = useSeededState(initialInput);
  const [initialRaw] = useSeededState(initialInput);
  const [typedValue, setTypedValue] = useSeededState(projected);
  const validationError = useRequiredFormField(fieldKey, props.placementId, typedValue, {
    label,
    missing: required && !disabled && !readOnly && typedValue === null,
  });
  const invalidLocalTime =
    raw !== "" && raw !== initialRaw && toStoredInstant(raw, timeZone) === undefined;
  const error = invalidLocalTime
    ? "Enter a valid, unambiguous date and time in the shown time zone."
    : (projectedError ?? validationError);

  const commit = (next: string): void => {
    if (disabled || readOnly) return;
    setRaw(next);
    const value =
      next === initialRaw
        ? projected
        : next === ""
          ? null
          : (toStoredInstant(next, timeZone) ?? next);
    setTypedValue(value);
    context.events?.field_changed?.({
      event: "field_changed",
      origin: "user",
      depth: 0,
      immediate: false,
      fieldKey,
      value,
    });
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>): void => commit(event.target.value);
  return (
    <Field
      onBlur={(event) => {
        if (!disabled && !readOnly)
          fieldFocusLost(event, context.events?.field_focus_lost, fieldKey, typedValue);
      }}
      data-vortex-control="date-time-input"
      hidden={draftFeedback?.hidden === true}
      data-vortex-placement-id={props.placementId}
      data-vortex-field-key={fieldKey}
      data-vortex-time-zone={timeZone}
    >
      <FieldLabel htmlFor={ids.control}>
        <FieldLabelText label={label} required={required} />
      </FieldLabel>
      <Input
        id={ids.control}
        type="datetime-local"
        step={1}
        name={fieldKey}
        value={raw}
        onChange={onChange}
        disabled={disabled}
        readOnly={readOnly}
        required={required}
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
