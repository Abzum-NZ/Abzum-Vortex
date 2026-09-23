import { useEffect, type FormEvent, type ReactElement } from "react";
import type { PlatformBlockRenderProps } from "../registry";
import {
  getAccessibleName,
  type ControlEventHandlers,
  type ProjectedControlData,
} from "./projected-data";

export type FormContainerProps = PlatformBlockRenderProps & {
  controlData?: ProjectedControlData;
  controlEvents?: ControlEventHandlers;
};

/**
 * Form container component wrapping child inputs and action buttons in an accessible form element:
 * - Emits form_ready semantic event on mount
 * - Emits form_submit semantic event on submission (Enter in text inputs or submit button clicks)
 * - Emits form_reset semantic event on reset
 * - Prevents default browser page reloads
 * - Accessible naming via declared title property
 */
export function FormContainer({
  placementId,
  settings,
  metadata,
  slots,
  availability,
  controlData,
  controlEvents,
}: FormContainerProps): ReactElement {
  const title = getAccessibleName(settings, metadata);
  const formId =
    settings.form_id?.kind === "text" && settings.form_id.value.trim().length > 0
      ? settings.form_id.value.trim()
      : placementId;

  // Emit form_ready on mount
  useEffect(() => {
    if (availability === "available" && controlEvents?.form_ready) {
      controlEvents.form_ready({ event: "form_ready", formId });
    }
  }, [availability, controlEvents, formId]);

  const handleSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (availability !== "available") return;

    const projectedValues =
      controlData?.status === "ready" && controlData.values.kind === "form"
        ? controlData.values.values
        : undefined;

    if (controlEvents?.form_submit) {
      controlEvents.form_submit({
        event: "form_submit",
        formId,
        ...(projectedValues ? { values: projectedValues } : {}),
      });
    }
  };

  const handleReset = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (availability !== "available") return;

    if (controlEvents?.form_reset) {
      controlEvents.form_reset({
        event: "form_reset",
        formId,
      });
    }
  };

  return (
    <form
      id={`vortex-form-${formId}`}
      name={formId}
      onSubmit={handleSubmit}
      onReset={handleReset}
      data-vortex-control="form-container"
      data-vortex-form-id={formId}
      data-vortex-availability={availability}
      {...(title ? { "aria-label": title } : {})}
      className="vortex-form-container"
      style={{ display: "flex", flexDirection: "column", gap: "1rem", width: "100%" }}
    >
      {title && (
        <h3
          style={{
            margin: 0,
            fontSize: "1.125rem",
            fontWeight: 600,
            color: "#111827",
            borderBottom: "1px solid #e5e7eb",
            paddingBottom: "0.5rem",
          }}
        >
          {title}
        </h3>
      )}

      {slots.content}
    </form>
  );
}
