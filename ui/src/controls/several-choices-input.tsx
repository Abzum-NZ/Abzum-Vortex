"use client";

import { useRef, type ReactElement } from "react";
import { Checkbox } from "../components/checkbox";
import { Field, FieldLabel, FieldLegend, FieldSet } from "../components/field";
import { DefinitionRenderError } from "../definition-error";
import type { SeveralChoicesInputPayload } from "./projected-data";
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
import { equalFormValue, useFormField, useFormFieldError } from "./form-context";

export type SeveralChoicesInputProps = ControlRenderProps<SeveralChoicesInputPayload>;

const EMPTY_SELECTION: readonly string[] = Object.freeze([]);

/** A multi-select control for the exact option values declared by a several_choices field. */
export function SeveralChoicesInput(props: SeveralChoicesInputProps): ReactElement {
  const context = resolveControlContext<SeveralChoicesInputPayload>(props, ["field_changed"]);
  const settings = readControlSettings(props, context.location);
  const ids = useFieldIds();
  const fieldKey = settings.fieldKey();
  const label = context.accessibleName ?? props.metadata.name;
  const help = settings.text("help_text");
  const required = settings.boolean("required");
  const draftFeedback = useFieldFeedback(fieldKey);
  const disabled =
    context.inactive || settings.boolean("disabled") || draftFeedback?.disabled === true;
  const options = settings.options("options");
  const maximumSelections = settings.number("maximum_selections");
  const error = context.values?.error;
  const note = inactiveNote(context);
  const projected = context.values?.value ?? EMPTY_SELECTION;

  if (
    new Set(projected).size !== projected.length ||
    projected.some((key) => !options.some((option) => option.key === key)) ||
    (maximumSelections !== undefined && projected.length > maximumSelections)
  )
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      "Several-choice values must be unique declared options within the selection limit",
      context.location,
    );

  // Rebuilt but equal projected arrays must not erase the person's local selections.
  const seed = useRef(projected);
  if (!equalFormValue(seed.current, projected)) seed.current = projected;
  const [selected, setSelected] = useSeededState<readonly string[]>(seed.current);
  const allowedSelected = selected.filter((key) => options.some((option) => option.key === key));
  const selectedSet = new Set(allowedSelected);
  const atLimit = maximumSelections !== undefined && allowedSelected.length >= maximumSelections;
  useFormField(
    fieldKey,
    props.placementId,
    allowedSelected,
    required && allowedSelected.length === 0 ? () => `${label} is required.` : undefined,
  );
  const validationError = useFormFieldError(fieldKey);
  const fieldError = error ?? validationError;

  const change = (key: string, checked: boolean): void => {
    if (disabled) return;
    const nextSet = new Set(allowedSelected);
    if (checked && (maximumSelections === undefined || nextSet.size < maximumSelections))
      nextSet.add(key);
    else if (!checked) nextSet.delete(key);
    const value = [...nextSet];
    setSelected(value);
    context.events?.field_changed?.({ event: "field_changed", fieldKey, value });
  };

  const described = describedBy(ids, help, fieldError, note, draftFeedback);
  return (
    <Field
      data-vortex-control="several-choices-input"
      hidden={draftFeedback?.hidden === true}
      data-vortex-placement-id={props.placementId}
      data-vortex-field-key={fieldKey}
      role="group"
      aria-labelledby={ids.label}
      aria-describedby={described["aria-describedby"]}
      aria-required={required || described["aria-required"] === true}
      aria-invalid={fieldError !== undefined}
    >
      <FieldSet disabled={disabled} className="flex flex-col gap-2">
        <FieldLegend id={ids.label} variant="label">
          <FieldLabelText label={label} required={required} />
        </FieldLegend>
        <div className="max-h-64 overflow-y-auto">
          {options.map((option, index) => {
            const optionId = `${ids.control}-option-${index}`;
            const checked = selectedSet.has(option.key);
            return (
              <Field key={option.key} orientation="horizontal">
                <Checkbox
                  id={optionId}
                  checked={checked}
                  disabled={disabled || (!checked && atLimit)}
                  aria-invalid={fieldError !== undefined}
                  onCheckedChange={(next) => change(option.key, next === true)}
                />
                <FieldLabel htmlFor={optionId}>{option.label}</FieldLabel>
              </Field>
            );
          })}
        </div>
      </FieldSet>
      <FieldMessages
        ids={ids}
        help={help}
        error={fieldError}
        note={note}
        draftFeedback={draftFeedback}
      />
    </Field>
  );
}
