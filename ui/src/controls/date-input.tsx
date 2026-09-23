import { useState, useId, type ChangeEvent, type ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import {
  getAccessibleName,
  type ControlEventHandlers,
  type ProjectedControlData,
} from "./projected-data";

export type DateInputProps = PlatformBlockRenderProps & {
  controlData?: ProjectedControlData;
  controlEvents?: ControlEventHandlers;
};

/**
 * Typed date input component supporting ISO calendar dates, accessible labeling,
 * error announcements, keyboard entry, and declared field_changed semantic event
 * emission with typed string | null values.
 */
export function DateInput({
  placementId,
  settings,
  metadata,
  availability,
  controlData,
  controlEvents,
}: DateInputProps): ReactElement {
  const generatedId = useId();
  const inputId = `vortex-date-${placementId}-${generatedId}`;
  const helpId = `vortex-help-${placementId}-${generatedId}`;
  const errorId = `vortex-error-${placementId}-${generatedId}`;

  // Read settings
  const fieldKey =
    settings.name?.kind === "text" && settings.name.value.trim().length > 0
      ? settings.name.value.trim()
      : placementId;
  const labelText = getAccessibleName(settings, metadata) ?? "Date input";
  const helpText = settings.help_text?.kind === "text" ? settings.help_text.value : undefined;
  const isRequired = settings.required?.kind === "boolean" ? settings.required.value : false;
  const isSettingDisabled = settings.disabled?.kind === "boolean" ? settings.disabled.value : false;
  const isReadOnly = settings.read_only?.kind === "boolean" ? settings.read_only.value : false;

  // Check projected control data
  const isControlDisabled = controlData?.status === "disabled";
  const isDisabled =
    availability === "unavailable" || isSettingDisabled || isControlDisabled;

  const projectedValue =
    controlData?.status === "ready" && controlData.values.kind === "date_input"
      ? controlData.values.value
      : undefined;
  const projectedError =
    controlData?.status === "ready" && controlData.values.kind === "date_input"
      ? controlData.values.error
      : undefined;

  const [internalValue, setInternalValue] = useState<string>(projectedValue ?? "");
  const displayValue =
    projectedValue !== undefined ? (projectedValue === null ? "" : projectedValue) : internalValue;

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

    const typedVal: string | null = raw.trim().length > 0 ? raw.trim() : null;
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
      data-vortex-control="date-input"
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
        type="date"
        name={fieldKey}
        value={displayValue}
        onChange={handleChange}
        disabled={isDisabled}
        readOnly={isReadOnly}
        required={isRequired}
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
