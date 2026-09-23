import { useState, useId, type ChangeEvent, type KeyboardEvent, type ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import {
  getAccessibleName,
  type ControlEventHandlers,
  type ProjectedControlData,
} from "./projected-data";

export type BooleanInputProps = PlatformBlockRenderProps & {
  controlData?: ProjectedControlData;
  controlEvents?: ControlEventHandlers;
};

/**
 * Typed boolean input component supporting checkbox and switch variants,
 * keyboard toggle activation (Space key), accessible labeling, and declared
 * field_changed semantic event emission with boolean values.
 */
export function BooleanInput({
  placementId,
  settings,
  metadata,
  availability,
  controlData,
  controlEvents,
}: BooleanInputProps): ReactElement {
  const generatedId = useId();
  const inputId = `vortex-boolean-${placementId}-${generatedId}`;
  const helpId = `vortex-help-${placementId}-${generatedId}`;
  const errorId = `vortex-error-${placementId}-${generatedId}`;

  // Read settings
  const fieldKey =
    settings.name?.kind === "text" && settings.name.value.trim().length > 0
      ? settings.name.value.trim()
      : placementId;
  const labelText = getAccessibleName(settings, metadata) ?? "Boolean input";
  const helpText = settings.help_text?.kind === "text" ? settings.help_text.value : undefined;
  const isRequired = settings.required?.kind === "boolean" ? settings.required.value : false;
  const isSettingDisabled = settings.disabled?.kind === "boolean" ? settings.disabled.value : false;
  const variant = settings.variant?.kind === "choice" ? settings.variant.value : "checkbox";

  // Check projected control data
  const isControlDisabled = controlData?.status === "disabled";
  const isDisabled =
    availability === "unavailable" || isSettingDisabled || isControlDisabled;

  const projectedValue =
    controlData?.status === "ready" && controlData.values.kind === "boolean_input"
      ? controlData.values.value
      : undefined;
  const projectedError =
    controlData?.status === "ready" && controlData.values.kind === "boolean_input"
      ? controlData.values.error
      : undefined;

  const [internalValue, setInternalValue] = useState<boolean>(projectedValue ?? false);
  const checked = projectedValue !== undefined ? projectedValue : internalValue;

  const describedBy = [
    helpText ? helpId : undefined,
    projectedError ? errorId : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  const notifyChange = (next: boolean): void => {
    if (isDisabled) return;
    setInternalValue(next);
    if (availability === "available" && controlEvents?.field_changed) {
      controlEvents.field_changed({
        event: "field_changed",
        fieldKey,
        value: next,
      });
    }
  };

  const handleCheckboxChange = (e: ChangeEvent<HTMLInputElement>): void => {
    notifyChange(e.target.checked);
  };

  const handleSwitchKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      notifyChange(!checked);
    }
  };

  return (
    <div
      data-vortex-control="boolean-input"
      data-vortex-field-key={fieldKey}
      data-vortex-availability={availability}
      className="vortex-field-container"
      style={{ display: "flex", flexDirection: "column", gap: "0.25rem", width: "100%" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        {variant === "switch" ? (
          <button
            id={inputId}
            type="button"
            role="switch"
            aria-checked={checked ? "true" : "false"}
            aria-label={labelText}
            aria-required={isRequired}
            aria-invalid={projectedError ? "true" : "false"}
            {...(describedBy.length > 0 ? { "aria-describedby": describedBy } : {})}
            disabled={isDisabled}
            onClick={() => notifyChange(!checked)}
            onKeyDown={handleSwitchKeyDown}
            className="vortex-switch"
            style={{
              position: "relative",
              width: "2.5rem",
              height: "1.25rem",
              borderRadius: "9999px",
              backgroundColor: checked ? "#2563eb" : "#d1d5db",
              border: "none",
              cursor: isDisabled ? "not-allowed" : "pointer",
              opacity: isDisabled ? 0.6 : 1,
              transition: "background-color 0.2s",
              padding: "0.125rem",
            }}
          >
            <span
              style={{
                display: "block",
                width: "1rem",
                height: "1rem",
                borderRadius: "50%",
                backgroundColor: "#ffffff",
                transform: checked ? "translateX(1.25rem)" : "translateX(0)",
                transition: "transform 0.2s",
              }}
            />
          </button>
        ) : (
          <input
            id={inputId}
            type="checkbox"
            name={fieldKey}
            checked={checked}
            onChange={handleCheckboxChange}
            disabled={isDisabled}
            required={isRequired}
            aria-label={labelText}
            aria-required={isRequired}
            aria-invalid={projectedError ? "true" : "false"}
            {...(describedBy.length > 0 ? { "aria-describedby": describedBy } : {})}
            className="vortex-checkbox"
            style={{
              width: "1.125rem",
              height: "1.125rem",
              cursor: isDisabled ? "not-allowed" : "pointer",
              opacity: isDisabled ? 0.6 : 1,
            }}
          />
        )}

        <label
          htmlFor={inputId}
          className="vortex-field-label"
          style={{ fontWeight: 500, fontSize: "0.875rem", cursor: isDisabled ? "not-allowed" : "pointer" }}
        >
          {labelText}
          {isRequired && (
            <span aria-hidden="true" style={{ color: "red", marginLeft: "0.25rem" }}>
              *
            </span>
          )}
        </label>
      </div>

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
