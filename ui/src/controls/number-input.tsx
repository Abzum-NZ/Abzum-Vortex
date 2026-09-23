import { useState, useId, type ChangeEvent, type ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import {
  getAccessibleName,
  type ControlEventHandlers,
  type ProjectedControlData,
} from "./projected-data";

export type NumberInputProps = PlatformBlockRenderProps & {
  controlData?: ProjectedControlData;
  controlEvents?: ControlEventHandlers;
};

/**
 * Typed number input component supporting min, max, step, and integer constraints,
 * accessible labels, error announcements, keyboard step interaction, and declared
 * field_changed semantic event emission with typed number | null values.
 */
export function NumberInput({
  placementId,
  settings,
  metadata,
  availability,
  controlData,
  controlEvents,
}: NumberInputProps): ReactElement {
  const generatedId = useId();
  const inputId = `vortex-number-${placementId}-${generatedId}`;
  const helpId = `vortex-help-${placementId}-${generatedId}`;
  const errorId = `vortex-error-${placementId}-${generatedId}`;

  // Read settings
  const fieldKey =
    settings.name?.kind === "text" && settings.name.value.trim().length > 0
      ? settings.name.value.trim()
      : placementId;
  const labelText = getAccessibleName(settings, metadata) ?? "Number input";
  const placeholder = settings.placeholder?.kind === "text" ? settings.placeholder.value : undefined;
  const helpText = settings.help_text?.kind === "text" ? settings.help_text.value : undefined;
  const isRequired = settings.required?.kind === "boolean" ? settings.required.value : false;
  const isSettingDisabled = settings.disabled?.kind === "boolean" ? settings.disabled.value : false;
  const isReadOnly = settings.read_only?.kind === "boolean" ? settings.read_only.value : false;
  const isInteger = settings.integer?.kind === "boolean" ? settings.integer.value : false;
  const minValue = settings.min_value?.kind === "number" ? settings.min_value.value : undefined;
  const maxValue = settings.max_value?.kind === "number" ? settings.max_value.value : undefined;
  const stepValue = settings.step_value?.kind === "number" ? settings.step_value.value : isInteger ? 1 : "any";

  // Check projected control data
  const isControlDisabled = controlData?.status === "disabled";
  const isDisabled =
    availability === "unavailable" || isSettingDisabled || isControlDisabled;

  const projectedValue =
    controlData?.status === "ready" && controlData.values.kind === "number_input"
      ? controlData.values.value
      : undefined;
  const projectedError =
    controlData?.status === "ready" && controlData.values.kind === "number_input"
      ? controlData.values.error
      : undefined;

  const [internalValue, setInternalValue] = useState<string>(
    projectedValue !== undefined && projectedValue !== null ? String(projectedValue) : "",
  );
  const displayValue =
    projectedValue !== undefined
      ? projectedValue === null
        ? ""
        : String(projectedValue)
      : internalValue;

  const describedBy = [
    helpText ? helpId : undefined,
    projectedError ? errorId : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  const handleChange = (e: ChangeEvent<HTMLInputElement>): void => {
    if (isDisabled || isReadOnly) return;
    const raw = e.target.value;
    setInternalValue(raw);

    let typedVal: number | null = null;
    if (raw.trim().length > 0) {
      const parsed = isInteger ? parseInt(raw, 10) : parseFloat(raw);
      if (Number.isFinite(parsed)) typedVal = parsed;
    }

    if (availability === "available" && controlEvents?.field_changed) {
      controlEvents.field_changed({
        event: "field_changed",
        fieldKey,
        value: typedVal,
      });
    }
  };

  return (
    <div
      data-vortex-control="number-input"
      data-vortex-field-key={fieldKey}
      data-vortex-availability={availability}
      className="vortex-field-container"
      style={{ display: "flex", flexDirection: "column", gap: "0.25rem", width: "100%" }}
    >
      <label
        htmlFor={inputId}
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

      <input
        id={inputId}
        type="number"
        name={fieldKey}
        value={displayValue}
        onChange={handleChange}
        disabled={isDisabled}
        readOnly={isReadOnly}
        required={isRequired}
        placeholder={placeholder}
        min={minValue}
        max={maxValue}
        step={stepValue}
        aria-label={labelText}
        aria-required={isRequired}
        aria-invalid={projectedError ? "true" : "false"}
        {...(describedBy.length > 0 ? { "aria-describedby": describedBy } : {})}
        className="vortex-input"
        style={{
          padding: "0.5rem",
          borderRadius: "0.25rem",
          border: projectedError ? "1px solid red" : "1px solid #ccc",
          opacity: isDisabled ? 0.6 : 1,
          cursor: isDisabled ? "not-allowed" : "text",
        }}
      />

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
