"use client";

import { useState, type ChangeEvent, type ReactElement } from "react";
import { format } from "date-fns";
import { CalendarIcon } from "lucide-react";
import { Button } from "../components/button";
import { Calendar } from "../components/calendar";
import { Field, FieldLabel } from "../components/field";
import { Input } from "../components/input";
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

/** The projected ISO calendar date as the local calendar day the month grid shows. */
const toCalendarDay = (iso: string): Date | undefined =>
  isIsoCalendarDate(iso) ? new Date(`${iso}T00:00:00`) : undefined;

/** The day a person chose in the month grid as an ISO calendar date, in the browser's own zone. */
const toIsoCalendarDate = (day: Date): string => format(day, "yyyy-MM-dd");

/**
 * ISO calendar date input emitting only its declared `field_changed` event. The typed value is
 * a real `YYYY-MM-DD` date or `null` for empty or incomplete entry. The date stays typeable from
 * the keyboard; a companion button opens the month grid in a popover and announces the chosen
 * day in the surrounding locale through the date-format context.
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

  const commit = (next: string): void => {
    if (disabled || readOnly) return;
    setRaw(next);
    context.events?.field_changed?.({ event: "field_changed", fieldKey, value: toTyped(next) });
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>): void => commit(event.target.value);

  const choose = (day: Date | undefined): void => {
    setOpen(false);
    commit(day === undefined ? "" : toIsoCalendarDate(day));
  };

  const chosenDay = toCalendarDay(raw);
  const pickerUnavailable = disabled || readOnly;
  return (
    <Field
      data-vortex-control="date-input"
      hidden={draftFeedback?.hidden === true}
      data-vortex-placement-id={props.placementId}
      data-vortex-field-key={fieldKey}
    >
      <FieldLabel htmlFor={ids.control}>
        <FieldLabelText label={label} required={required} />
      </FieldLabel>
      <div className="flex items-center gap-2">
        <Input
          id={ids.control}
          type="date"
          name={fieldKey}
          value={raw}
          onChange={onChange}
          disabled={disabled}
          readOnly={readOnly}
          required={required}
          aria-invalid={error !== undefined}
          {...describedBy(ids, help, error, note, draftFeedback)}
          className="[&::-webkit-calendar-picker-indicator]:hidden"
        />
        <Popover open={!pickerUnavailable && open} onOpenChange={(next) => setOpen(next)}>
          <PopoverTrigger
            render={<Button variant="outline" size="icon" />}
            disabled={pickerUnavailable}
          >
            <CalendarIcon aria-hidden="true" />
            <span className="sr-only">
              {"Choose date"}
              {chosenDay === undefined ? null : (
                <>
                  {", "}
                  <FormattedDate iso={raw} />
                </>
              )}
            </span>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0">
            <Calendar
              mode="single"
              selected={chosenDay}
              {...(chosenDay === undefined ? {} : { defaultMonth: chosenDay })}
              onSelect={choose}
              autoFocus
            />
          </PopoverContent>
        </Popover>
      </div>
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
