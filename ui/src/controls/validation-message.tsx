import type { ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import {
  getAccessibleName,
  type ControlEventHandlers,
  type ProjectedControlData,
} from "./projected-data";

export type ValidationMessageProps = PlatformBlockRenderProps & {
  controlData?: ProjectedControlData;
  controlEvents?: ControlEventHandlers;
};

/**
 * Validation message component displaying form and field errors with full
 * screen-reader announcement (role="alert" or role="status"), severity styling,
 * and fail-closed projected error handling.
 */
export function ValidationMessage({
  settings,
  metadata,
  controlData,
}: ValidationMessageProps): ReactElement {
  const authoredTitle = getAccessibleName(settings, metadata);
  const staticMessage = settings.message?.kind === "text" ? settings.message.value : undefined;
  const severity = settings.severity?.kind === "choice" ? settings.severity.value : "error";
  const forField = settings.for_field?.kind === "text" ? settings.for_field.value : undefined;

  const projectedErrors =
    controlData?.status === "ready" && controlData.values.kind === "validation"
      ? controlData.values.errors
      : undefined;

  const errors: readonly string[] =
    projectedErrors && projectedErrors.length > 0
      ? projectedErrors
      : staticMessage
        ? [staticMessage]
        : [];

  if (errors.length === 0 && !authoredTitle) {
    return <div data-vortex-control="validation-message" aria-hidden="true" />;
  }

  const role = severity === "error" ? "alert" : "status";
  const ariaLive = severity === "error" ? "assertive" : "polite";

  const colorStyles =
    severity === "error"
      ? { bg: "#fef2f2", border: "#f87171", text: "#991b1b" }
      : severity === "warning"
        ? { bg: "#fffbeb", border: "#fcd34d", text: "#92400e" }
        : { bg: "#eff6ff", border: "#93c5fd", text: "#1e40af" };

  return (
    <div
      role={role}
      aria-live={ariaLive}
      data-vortex-control="validation-message"
      data-vortex-severity={severity}
      {...(forField ? { "data-vortex-for-field": forField } : {})}
      className="vortex-validation-message"
      style={{
        padding: "0.75rem 1rem",
        borderRadius: "0.375rem",
        backgroundColor: colorStyles.bg,
        border: `1px solid ${colorStyles.border}`,
        color: colorStyles.text,
        fontSize: "0.875rem",
      }}
    >
      {authoredTitle && (
        <div style={{ fontWeight: 600, marginBottom: errors.length > 0 ? "0.25rem" : 0 }}>
          {authoredTitle}
        </div>
      )}
      {errors.length === 1 ? (
        <div>{errors[0]}</div>
      ) : errors.length > 1 ? (
        <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
          {errors.map((err, idx) => (
            <li key={idx}>{err}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
