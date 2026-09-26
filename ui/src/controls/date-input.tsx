"use client";

import { useState, type ReactElement } from "react";
import { format } from "date-fns";
import { Button } from "../components/button";
import { Calendar } from "../components/calendar";
import { Field, FieldLabel } from "../components/field";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";
import { FormattedDate } from "../display/date-format-context";
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
import { isIsoCalendarDate, type DateInputPayload } from "./projected-data";

export type DateInputProps = ControlRenderProps<DateInputPayload>;

/** Fixed hint for a date nobody has chosen yet; this control declares no placeholder property. */
const EMPTY_DATE = "Select a date";

/** The projected ISO calendar date as the local calendar day the month grid shows. */
const toCalendarDay = (iso: string): Date | undefined =>
  isIsoCalendarDate(iso) ? new Date(`${iso}T00:00:00`) : undefined;

/** The day a person chose in the month grid as an ISO calendar date, in the browser's own zone. */
const toIsoCalendarDate = (day: Date): string => format(day, "yyyy-MM-dd");

/**
 * ISO calendar date input emitting only its declared `field_changed` event. The typed value is a
 * real `YYYY-MM-DD` date or `null` until a day is chosen; the chosen day is shown and announced
 * in the surrounding locale through the date-format context, and the month grid opens in a popover.
 */
export function DateInput(props: DateInputProps): ReactElement {
  const context = resolveControlContext<DateInputPayload>(props, ["field_changed"]);
  const settings = readControlSettings(props, context.location);
  const ids = useFieldIds();
  const fieldKey = settings.fieldKey();
  const label = context.accessibleName ?? props.metadata.name;
  const help = settings.text("help_text");
  const required = settings.boolean("required");
  const readOnly = settings.boolean("read_only");
  const draftFeedback = useFieldFeedback(fieldKey);
  const disabled =
    context.inactive || settings.boolean("disabled") || draftFeedback?.disabled === true;
  const error = context.values?.error;
  const note = inactiveNote(context);

  const [raw, setRaw] = useSeededState(context.values?.value ?? "");
  const toTyped = (text: string): string | null => (isIsoCalendarDate(text) ? text : null);
  useFormField(fieldKey, props.placementId, toTyped(raw));
  const [open, setOpen] = useState(false);

  const choose = (day: Date | undefined): void => {
    if (disabled || readOnly) return;
    const chosen = day === undefined ? "" : toIsoCalendarDate(day);
    setOpen(false);
    setRaw(chosen);
    context.events?.field_changed?.({ event: "field_changed", fieldKey, value: toTyped(chosen) });
  };

  return (
    <Field
      data-vortex-control="date-input"
      hidden={draftFeedback?.hidden === true}
      data-vortex-placement-id={props.placementId}
      data-vortex-field-key={fieldKey}
    >
      <FieldLabel id={ids.label} htmlFor={ids.control}>
        <FieldLabelText label={label} required={required} />
      </FieldLabel>
      <Popover open={!readOnly && open} onOpenChange={(next) => setOpen(next)}>
        <PopoverTrigger
          id={ids.control}
          render={<Button variant="outline" className="w-full justify-start font-normal" />}
          disabled={disabled}
          aria-labelledby={ids.label}
          aria-invalid={error !== undefined}
          {...(required ? { "aria-required": true } : {})}
          {...describedBy(ids, help, error, note, draftFeedback)}
        >
          {raw === "" ? (
            <span className="text-muted-foreground">{EMPTY_DATE}</span>
          ) : (
            <FormattedDate iso={raw} />
          )}
        </PopoverTrigger>
        <PopoverContent>
          <Calendar mode="single" selected={toCalendarDay(raw)} onSelect={choose} />
        </PopoverContent>
      </Popover>
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
