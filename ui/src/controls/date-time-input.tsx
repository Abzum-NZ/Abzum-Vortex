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
} from "./field-parts";
import { useFormField } from "./form-context";

export type DateTimeInputProps = ControlRenderProps<DateTimeInputPayload>;

type DateTimeParts = Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}>;

const DATE_TIME_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

const formatterFor = (timeZone: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

const partsAt = (instant: number, timeZone: string): DateTimeParts => {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    second: part("second"),
  };
};

const inputText = (parts: DateTimeParts): string =>
  `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}`;

const utcMilliseconds = (parts: DateTimeParts): number => {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, 0);
  return date.getTime();
};

const parseLocalParts = (raw: string): DateTimeParts | undefined => {
  const match = DATE_TIME_LOCAL.exec(raw);
  if (match === null) return undefined;
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? "0"),
  };
  if (
    parts.month < 1 ||
    parts.month > 12 ||
    parts.day < 1 ||
    parts.hour > 23 ||
    parts.minute > 59 ||
    parts.second > 59
  )
    return undefined;
  const calendar = new Date(0);
  calendar.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  calendar.setUTCHours(0, 0, 0, 0);
  return calendar.getUTCFullYear() === parts.year &&
    calendar.getUTCMonth() === parts.month - 1 &&
    calendar.getUTCDate() === parts.day
    ? parts
    : undefined;
};

/** Formats one stored instant for the field's effective display time zone. */
const toLocalInputValue = (value: string | null, timeZone: string): string => {
  if (value === null) return "";
  const instant = Date.parse(value);
  if (Number.isNaN(instant)) return "";
  return inputText(partsAt(instant, timeZone));
};

/** Converts an unambiguous wall-clock input to an ISO instant. */
const toStoredInstant = (raw: string, timeZone: string): string | undefined => {
  const local = parseLocalParts(raw);
  if (local === undefined) return undefined;
  const wallClock = utcMilliseconds(local);
  const offsets = new Set<number>();
  for (const probe of [
    wallClock - 36 * 60 * 60 * 1_000,
    wallClock,
    wallClock + 36 * 60 * 60 * 1_000,
  ]) {
    const zoned = partsAt(probe, timeZone);
    offsets.add(utcMilliseconds(zoned) - probe);
  }
  const matches = [...offsets]
    .map((offset) => wallClock - offset)
    .filter((candidate) => inputText(partsAt(candidate, timeZone)) === inputText(local));
  return matches.length === 1 ? new Date(matches[0]!).toISOString() : undefined;
};

/**
 * Collects a time-zone-aware instant using the field's declared display policy. The browser
 * resolves the person's fallback zone after hydration when no profile zone is stored.
 */
export function DateTimeInput(props: DateTimeInputProps): ReactElement {
  const context = resolveControlContext<DateTimeInputPayload>(props, ["field_changed"]);
  const settings = readControlSettings(props, context.location);
  const [browserTimeZone, setBrowserTimeZone] = useState<string>();
  useEffect(() => {
    setBrowserTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);
  const ids = useFieldIds();
  const fieldKey = settings.fieldKey();
  const label = context.accessibleName ?? props.metadata.name;
  const authoredHelp = settings.text("help_text");
  const placeholder = settings.text("placeholder");
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
  useFormField(fieldKey, props.placementId, typedValue);
  const invalidLocalTime = raw !== "" && raw !== initialRaw && toStoredInstant(raw, timeZone) === undefined;
  const error = invalidLocalTime
    ? "Enter a valid, unambiguous date and time in the shown time zone."
    : projectedError;

  const commit = (next: string): void => {
    if (disabled || readOnly) return;
    setRaw(next);
    const value =
      next === initialRaw ? projected : next === "" ? null : (toStoredInstant(next, timeZone) ?? next);
    setTypedValue(value);
    context.events?.field_changed?.({ event: "field_changed", fieldKey, value });
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>): void => commit(event.target.value);
  return (
    <Field
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
        placeholder={placeholder}
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
