"use client";

import type { ChangeEvent, ReactElement } from "react";
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
import { isIsoCalendarDate, type DateInputPayload } from "./projected-data";
import { isIsoCalendarDate } from "./projected-data";

export type DateInputProps = PlatformBlockRenderProps;

/**
 * ISO calendar date input emitting only its declared `field_changed` event. The typed value is
 * a real `YYYY-MM-DD` date or `null` for empty or incomplete entry.
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

  const onChange = (event: ChangeEvent<HTMLInputElement>): void => {
    if (disabled || readOnly) return;
    const next = event.target.value;
    setRaw(next);
    context.events?.field_changed?.({ event: "field_changed", fieldKey, value: toTyped(next) });
  };

  return (
    <div
      data-vortex-control="date-input"
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
        type="date"
        name={fieldKey}
        value={raw}
        onChange={onChange}
        disabled={disabled}
        readOnly={readOnly}
        required={required}
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
