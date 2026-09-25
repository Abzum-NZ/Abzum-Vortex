"use client";

import { useState, type ReactElement } from "react";
import { DefinitionRenderError } from "../definition-error";
import type { ChoiceInputPayload } from "./projected-data";
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

export type ChoiceInputProps = ControlRenderProps<ChoiceInputPayload>;

/** Lists longer than this offer a search box; shorter lists are scanned directly. */
const SEARCHABLE_OPTION_THRESHOLD = 7;

/**
 * Select or radio-group choice emitting only its declared `field_changed` event with an exact
 * option key or `null`. Options come from the projection when supplied, otherwise from the
 * authored option list; duplicate option keys and unknown selected keys fail closed. Longer
 * lists, such as permitted record or account reference choices, can be searched by label; the
 * current selection stays visible while searching, and only an offered option key is ever
 * registered or emitted.
 */
export function ChoiceInput(props: ChoiceInputProps): ReactElement {
  const context = resolveControlContext<ChoiceInputPayload>(props, ["field_changed"]);
  const settings = readControlSettings(props, context.location);
  const ids = useFieldIds();
  const fieldKey = settings.fieldKey();
  const label = context.accessibleName ?? props.metadata.name;
  const help = settings.text("help_text");
  const placeholder = settings.text("placeholder") ?? "Select an option";
  const required = settings.boolean("required");
  const variant = settings.choice<"select" | "radio">("variant", "select");
  const draftFeedback = useFieldFeedback(fieldKey);
  const disabled =
    context.inactive || settings.boolean("disabled") || draftFeedback?.disabled === true;
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
  const [searchTerm, setSearchTerm] = useState("");

  // Only an option from the offered set may be registered in the form or submitted.
  const permittedSelected =
    selected !== null && options.some((option) => option.key === selected)
      ? selected
      : null;
  useFormField(fieldKey, props.placementId, permittedSelected);

  const change = (next: string): void => {
    if (disabled) return;
    const value = options.some((option) => option.key === next) ? next : null;
    setSelected(value);
    context.events?.field_changed?.({ event: "field_changed", fieldKey, value });
  };

  const searchable = options.length > SEARCHABLE_OPTION_THRESHOLD;
  const normalizedSearch = searchable ? searchTerm.trim().toLowerCase() : "";
  const filteredOptions =
    normalizedSearch.length === 0
      ? options
      : options.filter(
          (option) =>
            option.key === permittedSelected ||
            option.label.toLowerCase().includes(normalizedSearch),
        );

  const described = describedBy(ids, help, error, note, draftFeedback);
  const search = searchable ? (
    <div className="vortex-choice-search-box">
      <input
        id={`${ids.control}-search`}
        type="search"
        value={searchTerm}
        onChange={(event) => setSearchTerm(event.target.value)}
        aria-label={`Search ${label} options`}
        disabled={disabled}
        className="vortex-choice-search"
      />
    </div>
  ) : null;

  return (
    <div
      data-vortex-control="choice-input"
      hidden={draftFeedback?.hidden === true}
      data-vortex-placement-id={props.placementId}
      data-vortex-field-key={fieldKey}
      data-vortex-variant={variant}
      data-vortex-searchable={searchable ? "true" : "false"}
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
          {search}
          {normalizedSearch.length > 0 && filteredOptions.length === 0 ? (
            <div className="vortex-choice-empty" role="status">
              No matching options
            </div>
          ) : (
            filteredOptions.map((option) => {
              const optionId = `${ids.control}-${option.key}`;
              return (
                <div key={option.key} className="vortex-radio-option">
                  <input
                    id={optionId}
                    type="radio"
                    name={ids.control}
                    value={option.key}
                    checked={permittedSelected === option.key}
                    onChange={() => change(option.key)}
                    required={required}
                    aria-invalid={error !== undefined}
                    className="vortex-radio"
                  />
                  <label htmlFor={optionId}>{option.label}</label>
                </div>
              );
            })
          )}
        </fieldset>
      ) : (
        <>
          <label htmlFor={ids.control} className="vortex-field-label">
            <FieldLabelText label={label} required={required} />
          </label>
          {search}
          <select
            id={ids.control}
            name={fieldKey}
            value={permittedSelected ?? ""}
            onChange={(event) => change(event.target.value)}
            disabled={disabled}
            required={required}
            aria-invalid={error !== undefined}
            {...described}
            className="vortex-select"
          >
            <option value="">{placeholder}</option>
            {filteredOptions.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </>
      )}
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
