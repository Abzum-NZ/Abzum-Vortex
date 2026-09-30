"use client";

import { builderKeySchema } from "@vortex/contracts";
import type { ReactElement } from "react";
import { Alert, AlertDescription, AlertTitle } from "../components/alert";
import { DefinitionRenderError } from "../definition-error";
import type { ValidationPayload } from "./projected-data";
import {
  readControlSettings,
  resolveControlContext,
  type ControlRenderProps,
} from "./control-context";

export type ValidationMessageProps = ControlRenderProps<ValidationPayload>;

const VALIDATION_SEVERITY_COLORS: Readonly<Record<"error" | "warning" | "info", string>> = {
  error: "var(--vortex-danger-text)",
  warning: "var(--vortex-warning-text)",
  info: "var(--vortex-info-text)",
};

/**
 * Form-wide or field-targeted validation summary. The live region is always present so a later
 * projected error is announced: errors assertively as an alert, warnings and information politely.
 * It declares no semantic events.
 */
export function ValidationMessage(props: ValidationMessageProps): ReactElement {
  const context = resolveControlContext<ValidationPayload>(props, []);
  const settings = readControlSettings(props, context.location);
  const severity = settings.choice<"error" | "warning" | "info">("severity", "error");
  const message = settings.text("message");
  const forField = settings.text("for_field");
  if (forField !== undefined && !builderKeySchema.safeParse(forField).success)
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      "A validation target must be a field name",
      { ...context.location, propertyPath: ["for_field"] },
    );

  const projected = context.values?.errors;
  const messages: readonly string[] =
    projected !== undefined ? projected : message === undefined ? [] : [message];
  const title = context.accessibleName;
  const severityColor = VALIDATION_SEVERITY_COLORS[severity];

  return (
    <Alert
      role={severity === "error" ? "alert" : "status"}
      data-vortex-control="validation-message"
      data-vortex-placement-id={props.placementId}
      data-vortex-severity={severity}
      {...(forField === undefined ? {} : { "data-vortex-for-field": forField })}
      variant={severity === "error" ? "destructive" : "default"}
      className="border-l-4"
      style={{ backgroundColor: "var(--vortex-surface)", borderLeftColor: severityColor }}
    >
      {messages.length === 0 ? null : (
        <>
          {title === undefined ? null : (
            <AlertTitle className="mb-1 font-bold" style={{ color: severityColor }}>
              {title}
            </AlertTitle>
          )}
          <AlertDescription style={{ color: "var(--vortex-text)" }}>
            {messages.length === 1 ? (
              <p className="m-0">{messages[0]}</p>
            ) : (
              <ul className="m-0 list-disc pl-5">
                {messages.map((text, index) => (
                  <li key={index}>{text}</li>
                ))}
              </ul>
            )}
          </AlertDescription>
        </>
      )}
    </Alert>
  );
}
