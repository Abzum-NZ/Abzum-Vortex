"use client";

import type { ReactElement } from "react";
import { DefinitionRenderError } from "../definition-error";
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

export type ChoiceInputProps = PlatformBlockRenderProps;

/**
 * Select or radio-group choice emitting only its declared `field_changed` event with an exact
 * option key or `null`. Options come from the projection when supplied, otherwise from the
 * authored option list; duplicate option keys and unknown selected keys fail closed.
 */
export function ChoiceInput(props: ChoiceInputProps): ReactElement {
  const context = resolveControlContext(props, "choice_input", ["field_changed"]);
  const settings = readControlSettings(props, context.location);
  const ids = useFieldIds();
  const fieldKey = settings.fieldKey();
  const label = context.accessibleName ?? props.metadata.name;
  const help = settings.text("help_text");
  const placeholder = settings.text("placeholder") ?? "Select an option";
  const required = settings.boolean("required");
  const variant = settings.choice<"select" | "radio">("variant", "select");
  const disabled = context.inactive || settings.boolean("disabled");
  const options = context.values?.options ?? settings.options("options");
  const error = context.values?.error;
  const note = inactiveNote(context);

  const projected = context.values?.value;
  if (
    projected !== undefined &&
    projected !== null &&
    !options.some((option) => option.key === projected)
  )
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      `Choice value '${projected}' is not an available option`,
      context.location,
    );

  const [selected, setSelected] = useSeededState<string | null>(projected ?? null);
  useFormField(fieldKey, props.placementId, selected);

  const change = (next: string): void => {
    if (disabled) return;
    const value = options.some((option) => option.key === next) ? next : null;
    setSelected(value);
    context.events?.field_changed?.({ event: "field_changed", fieldKey, value });
  };

  const described = describedBy(ids, help, error, note);
  return (
    <div
      data-vortex-control="choice-input"
      data-vortex-placement-id={props.placementId}
      data-vortex-field-key={fieldKey}
      data-vortex-variant={variant}
      className="vortex-field"
    >
      {variant === "radio" ? (
        <fieldset
          disabled={disabled}
          {...described}
          className="vortex-radio-group"
        >
          <legend className="vortex-field-label">
            <FieldLabelText label={label} required={required} />
          </legend>
          {options.map((option) => {
            const optionId = `${ids.control}-${option.key}`;
            return (
              <div key={option.key} className="vortex-radio-option">
                <input
                  id={optionId}
                  type="radio"
                  name={ids.control}
                  value={option.key}
                  checked={selected === option.key}
                  onChange={() => change(option.key)}
                  required={required}
                  aria-invalid={error !== undefined}
                  className="vortex-radio"
                />
                <label htmlFor={optionId}>{option.label}</label>
              </div>
            );
          })}
        </fieldset>
      ) : (
        <>
          <label htmlFor={ids.control} className="vortex-field-label">
            <FieldLabelText label={label} required={required} />
          </label>
          <select
            id={ids.control}
            name={fieldKey}
            value={selected ?? ""}
            onChange={(event) => change(event.target.value)}
            disabled={disabled}
            required={required}
            aria-invalid={error !== undefined}
            {...described}
            className="vortex-select"
          >
            <option value="">{placeholder}</option>
            {options.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </>
      )}
      <FieldMessages ids={ids} help={help} error={error} note={note} />
    </div>
  );
}
