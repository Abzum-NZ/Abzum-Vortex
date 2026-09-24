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
import type { TypedRecordReference } from "./projected-data";

export type LinkInputProps = PlatformBlockRenderProps;

/**
 * A record-reference key is the exact `recordTypeId:recordId` pair of the linked record. It names
 * a reference only and never carries the record's values or grants access to it.
 */
const referenceKey = (reference: TypedRecordReference | null | undefined): string =>
  reference === null || reference === undefined
    ? ""
    : `${reference.recordTypeId}:${reference.recordId}`;

const parseReferenceKey = (text: string): TypedRecordReference | null => {
  const separator = text.indexOf(":");
  if (separator < 1 || separator === text.length - 1) return null;
  return {
    recordTypeId: text.slice(0, separator).trim(),
    recordId: text.slice(separator + 1).trim(),
  };
};

/**
 * Link field that collects one record reference of an authored allowed record type. It emits only
 * its declared `field_changed` event with the typed reference and publishes it to its enclosing
 * form; it never fetches or discloses the referenced record.
 */
export function LinkInput(props: LinkInputProps): ReactElement {
  const context = resolveControlContext(props, "link_input", ["field_changed"]);
  const settings = readControlSettings(props, context.location);
  const ids = useFieldIds();
  const fieldKey = settings.fieldKey();
  const label = context.accessibleName ?? props.metadata.name;
  const help = settings.text("help_text");
  const placeholder = settings.text("placeholder");
  const required = settings.boolean("required");
  const readOnly = settings.boolean("read_only");
  const disabled = context.inactive || settings.boolean("disabled");
  const allowedRecordTypeIds = settings.recordTypeIds("record_types");
  const error = context.values?.error;
  const note = inactiveNote(context);

  const [value, setValue] = useSeededState(referenceKey(context.values?.value));
  useFormField(fieldKey, props.placementId, parseReferenceKey(value));

  const onChange = (event: ChangeEvent<HTMLInputElement>): void => {
    if (disabled || readOnly) return;
    const next = event.target.value;
    setValue(next);
    const reference = parseReferenceKey(next);
    if (reference === null || !allowedRecordTypeIds.includes(reference.recordTypeId)) return;
    context.events?.field_changed?.({ event: "field_changed", fieldKey, value: reference });
  };

  return (
    <div
      data-vortex-control="link-input"
      data-vortex-placement-id={props.placementId}
      data-vortex-field-key={fieldKey}
      className="vortex-field"
    >
      <label htmlFor={ids.control} className="vortex-field-label">
        <FieldLabelText label={label} required={required} />
      </label>
      <input
        id={ids.control}
        name={fieldKey}
        type="text"
        value={value}
        onChange={onChange}
        disabled={disabled}
        readOnly={readOnly}
        required={required}
        {...(placeholder === undefined ? {} : { placeholder })}
        aria-invalid={error !== undefined}
        {...describedBy(ids, help, error, note)}
        className="vortex-input"
      />
      <FieldMessages ids={ids} help={help} error={error} note={note} />
    </div>
  );
}
