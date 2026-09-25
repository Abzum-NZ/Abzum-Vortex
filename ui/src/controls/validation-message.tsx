"use client";

import { builderKeySchema } from "@vortex/contracts";
import type { ReactElement } from "react";
import { DefinitionRenderError } from "../definition-error";
import type { PlatformBlockRenderProps } from "../registry";
import type { ValidationPayload } from "./projected-data";
import { readControlSettings, resolveControlContext } from "./control-context";

export type ValidationMessageProps = PlatformBlockRenderProps;

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

  return (
    <div
      role={severity === "error" ? "alert" : "status"}
      data-vortex-control="validation-message"
      data-vortex-placement-id={props.placementId}
      data-vortex-severity={severity}
      {...(forField === undefined ? {} : { "data-vortex-for-field": forField })}
      className={`vortex-validation-message vortex-validation-${severity}`}
    >
      {messages.length === 0 ? null : (
        <>
          {title === undefined ? null : <p className="vortex-validation-title">{title}</p>}
          {messages.length === 1 ? (
            <p className="vortex-validation-text">{messages[0]}</p>
          ) : (
            <ul className="vortex-validation-list">
              {messages.map((text, index) => (
                <li key={index}>{text}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
