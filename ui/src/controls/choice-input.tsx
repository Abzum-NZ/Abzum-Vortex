import { useState, useId, type ChangeEvent, type ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import {
  getAccessibleName,
  type ChoiceOption,
  type ControlEventHandlers,
  type ProjectedControlData,
} from "./projected-data";

export type ChoiceInputProps = PlatformBlockRenderProps & {
  controlData?: ProjectedControlData;
  controlEvents?: ControlEventHandlers;
};

const parseOptionsJson = (raw: string | undefined): readonly ChoiceOption[] => {
  if (!raw || raw.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (opt): opt is ChoiceOption =>
        typeof opt === "object" &&
        opt !== null &&
        typeof opt.key === "string" &&
        typeof opt.label === "string",
    );
  } catch {
    return [];
  }
};

/**
 * Typed choice input component supporting select dropdown and radio button group variants,
 * options parsing from authored JSON and projected data, keyboard navigation,
 * accessible labeling, and declared field_changed semantic event emission with typed choice keys.
 */
export function ChoiceInput({
  placementId,
  settings,
  metadata,
  availability,
  controlData,
  controlEvents,
}: ChoiceInputProps): ReactElement {
  const generatedId = useId();
  const inputId = `vortex-choice-${placementId}-${generatedId}`;
  const helpId = `vortex-help-${placementId}-${generatedId}`;
  const errorId = `vortex-error-${placementId}-${generatedId}`;

  // Read settings
  const fieldKey =
    settings.name?.kind === "text" && settings.name.value.trim().length > 0
      ? settings.name.value.trim()
      : placementId;
  const labelText = getAccessibleName(settings, metadata) ?? "Choice input";
  const placeholder =
    settings.placeholder?.kind === "text" && settings.placeholder.value.trim().length > 0
      ? settings.placeholder.value.trim()
      : "-- Select an option --";
  const helpText = settings.help_text?.kind === "text" ? settings.help_text.value : undefined;
  const isRequired = settings.required?.kind === "boolean" ? settings.required.value : false;
  const isSettingDisabled = settings.disabled?.kind === "boolean" ? settings.disabled.value : false;
  const variant = settings.variant?.kind === "choice" ? settings.variant.value : "select";
  const optionsRaw = settings.options_json?.kind === "text" ? settings.options_json.value : undefined;

  // Check projected control data
  const isControlDisabled = controlData?.status === "disabled";
  const isDisabled =
    availability === "unavailable" || isSettingDisabled || isControlDisabled;

  const projectedValue =
    controlData?.status === "ready" && controlData.values.kind === "choice_input"
      ? controlData.values.value
      : undefined;
  const projectedOptions =
    controlData?.status === "ready" && controlData.values.kind === "choice_input"
      ? controlData.values.options
      : undefined;
  const projectedError =
    controlData?.status === "ready" && controlData.values.kind === "choice_input"
      ? controlData.values.error
      : undefined;

  const effectiveOptions: readonly ChoiceOption[] =
    projectedOptions && projectedOptions.length > 0
      ? projectedOptions
      : parseOptionsJson(optionsRaw);

  const [internalValue, setInternalValue] = useState<string>(projectedValue ?? "");
  const selectedValue =
    projectedValue !== undefined ? (projectedValue === null ? "" : projectedValue) : internalValue;

  const describedBy = [
    helpText ? helpId : undefined,
    projectedError ? errorId : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  const notifyChange = (nextKey: string): void => {
    if (isDisabled) return;
    setInternalValue(nextKey);
    const typedVal: string | null = nextKey.trim().length > 0 ? nextKey : null;
    if (availability === "available" && controlEvents?.field_changed) {
      controlEvents.field_changed({
        event: "field_changed",
        fieldKey,
        value: typedVal,
      });
    }
  };

  const handleSelectChange = (e: ChangeEvent<HTMLSelectElement>): void => {
    notifyChange(e.target.value);
  };

  return (
    <div
      data-vortex-control="choice-input"
      data-vortex-field-key={fieldKey}
      data-vortex-availability={availability}
      className="vortex-field-container"
      style={{ display: "flex", flexDirection: "column", gap: "0.25rem", width: "100%" }}
    >
      <label
        htmlFor={variant === "select" ? inputId : undefined}
        id={variant === "radio" ? inputId : undefined}
        className="vortex-field-label"
        style={{ fontWeight: 500, fontSize: "0.875rem" }}
      >
        {labelText}
        {isRequired && (
          <span aria-hidden="true" style={{ color: "red", marginLeft: "0.25rem" }}>
            *
          </span>
        )}
      </label>

      {variant === "radio" ? (
        <div
          role="radiogroup"
          aria-labelledby={inputId}
          aria-required={isRequired}
          aria-invalid={projectedError ? "true" : "false"}
          {...(describedBy.length > 0 ? { "aria-describedby": describedBy } : {})}
          style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}
        >
          {effectiveOptions.map((opt) => {
            const radioId = `${inputId}-${opt.key}`;
            const isSelected = selectedValue === opt.key;
            return (
              <label
                key={opt.key}
                htmlFor={radioId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  cursor: isDisabled ? "not-allowed" : "pointer",
                  fontSize: "0.875rem",
                }}
              >
                <input
                  id={radioId}
                  type="radio"
                  name={fieldKey}
                  value={opt.key}
                  checked={isSelected}
                  onChange={() => notifyChange(opt.key)}
                  disabled={isDisabled}
                  style={{ cursor: isDisabled ? "not-allowed" : "pointer" }}
                />
                <span>{opt.label}</span>
              </label>
            );
          })}
        </div>
      ) : (
        <select
          id={inputId}
          name={fieldKey}
          value={selectedValue}
          onChange={handleSelectChange}
          disabled={isDisabled}
          required={isRequired}
          aria-label={labelText}
          aria-required={isRequired}
          aria-invalid={projectedError ? "true" : "false"}
          {...(describedBy.length > 0 ? { "aria-describedby": describedBy } : {})}
          className="vortex-select"
          style={{
            padding: "0.5rem",
            borderRadius: "0.25rem",
            border: projectedError ? "1px solid red" : "1px solid #ccc",
            opacity: isDisabled ? 0.6 : 1,
            cursor: isDisabled ? "not-allowed" : "pointer",
          }}
        >
          <option value="">{placeholder}</option>
          {effectiveOptions.map((opt) => (
            <option key={opt.key} value={opt.key}>
              {opt.label}
            </option>
          ))}
        </select>
      )}

      {helpText && (
        <span
          id={helpId}
          className="vortex-field-help"
          style={{ fontSize: "0.75rem", color: "#666" }}
        >
          {helpText}
        </span>
      )}

      {projectedError && (
        <span
          id={errorId}
          role="alert"
          aria-live="polite"
          className="vortex-field-error"
          style={{ fontSize: "0.75rem", color: "red" }}
        >
          {projectedError}
        </span>
      )}

      {availability === "unavailable" && (
        <span
          className="vortex-unavailable-notice"
          style={{ fontSize: "0.75rem", color: "#888", fontStyle: "italic" }}
        >
          Input is currently unavailable
        </span>
      )}
    </div>
  );
}
