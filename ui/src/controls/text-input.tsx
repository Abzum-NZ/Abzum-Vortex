import { useState, useId, type ChangeEvent, type ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import {
  getAccessibleName,
  type ControlEventHandlers,
  type ProjectedControlData,
} from "./projected-data";

export type TextInputProps = PlatformBlockRenderProps & {
  controlData?: ProjectedControlData;
  controlEvents?: ControlEventHandlers;
};

/**
 * Typed text input component supporting single-line (text, email, password, tel, url)
 * and multi-line textarea with full accessible labels, error announcements, keyboard interaction,
 * and declared field_changed semantic event emission.
 */
export function TextInput({
  placementId,
  settings,
  metadata,
  availability,
  controlData,
  controlEvents,
}: TextInputProps): ReactElement {
  const generatedId = useId();
  const inputId = `vortex-input-${placementId}-${generatedId}`;
  const helpId = `vortex-help-${placementId}-${generatedId}`;
  const errorId = `vortex-error-${placementId}-${generatedId}`;

  // Read settings
  const fieldKey =
    settings.name?.kind === "text" && settings.name.value.trim().length > 0
      ? settings.name.value.trim()
      : placementId;
  const labelText = getAccessibleName(settings, metadata) ?? "Text input";
  const placeholder = settings.placeholder?.kind === "text" ? settings.placeholder.value : undefined;
  const helpText = settings.help_text?.kind === "text" ? settings.help_text.value : undefined;
  const isRequired = settings.required?.kind === "boolean" ? settings.required.value : false;
  const isSettingDisabled = settings.disabled?.kind === "boolean" ? settings.disabled.value : false;
  const isReadOnly = settings.read_only?.kind === "boolean" ? settings.read_only.value : false;
  const isMultiline = settings.multiline?.kind === "boolean" ? settings.multiline.value : false;
  const inputType =
    settings.input_type?.kind === "choice" ? settings.input_type.value : "text";

  // Check projected control data
  const isControlDisabled = controlData?.status === "disabled";
  const isDisabled =
    availability === "unavailable" || isSettingDisabled || isControlDisabled;

  const projectedValue =
    controlData?.status === "ready" && controlData.values.kind === "text_input"
      ? controlData.values.value
      : undefined;
  const projectedError =
    controlData?.status === "ready" && controlData.values.kind === "text_input"
      ? controlData.values.error
      : undefined;

  const [internalValue, setInternalValue] = useState<string>(projectedValue ?? "");
  const currentValue = projectedValue !== undefined ? projectedValue : internalValue;

  const describedBy = [
    helpText ? helpId : undefined,
    projectedError ? errorId : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  const handleChange = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (isDisabled || isReadOnly) return;
    const next = e.target.value;
    setInternalValue(next);
    if (availability === "available" && controlEvents?.field_changed) {
      controlEvents.field_changed({
        event: "field_changed",
        fieldKey,
        value: next,
      });
    }
  };

  return (
    <div
      data-vortex-control="text-input"
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

      {isMultiline ? (
        <textarea
          id={inputId}
          name={fieldKey}
          value={currentValue}
          onChange={handleChange}
          disabled={isDisabled}
          readOnly={isReadOnly}
          required={isRequired}
          placeholder={placeholder}
          aria-label={labelText}
          aria-required={isRequired}
          aria-invalid={projectedError ? "true" : "false"}
          {...(describedBy.length > 0 ? { "aria-describedby": describedBy } : {})}
          className="vortex-textarea"
          style={{
            padding: "0.5rem",
            borderRadius: "0.25rem",
            border: projectedError ? "1px solid red" : "1px solid #ccc",
            minHeight: "4rem",
            opacity: isDisabled ? 0.6 : 1,
            cursor: isDisabled ? "not-allowed" : "text",
          }}
        />
      ) : (
        <input
          id={inputId}
          type={inputType}
          name={fieldKey}
          value={currentValue}
          onChange={handleChange}
          disabled={isDisabled}
          readOnly={isReadOnly}
          required={isRequired}
          placeholder={placeholder}
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
