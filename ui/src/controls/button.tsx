"use client";

import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import { DefinitionRenderError } from "../definition-error";
import type { ButtonPayload } from "./projected-data";
import {
  readControlSettings,
  resolveControlContext,
  type ControlRenderProps,
} from "./control-context";
import { useFormScope } from "./form-context";

export type ButtonProps = ControlRenderProps<ButtonPayload>;

type ButtonMode = "action" | "submit" | "reset";

/**
 * Native button activated by pointer, Enter or Space. An action button emits only its declared
 * `action` event. Submit and reset buttons must sit inside a form container and emit nothing
 * themselves: the form emits its one `form_submit` or `form_reset` event, so Enter in a field and
 * a Submit button share a single submission path.
 */
export function Button(props: ButtonProps): ReactElement {
  const settings = readControlSettings(props, {
    placementId: props.placementId,
    blockId: props.metadata.blockId,
    releaseVersion: props.metadata.releaseVersion,
  });
  const mode = settings.choice<ButtonMode>("action_kind", "action");
  const context = resolveControlContext<ButtonPayload>(props, mode === "action" ? ["action"] : []);
  const variant = settings.choice<"primary" | "secondary" | "danger" | "ghost">(
    "variant",
    "primary",
  );
  const form = useFormScope();
  const noteId = useId();
  // An action handler may return the promise of the flow it started; the button stays busy until it
  // settles, so one gesture cannot start the same flow twice.
  const [running, setRunning] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (mode !== "action" && form === undefined)
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      `A ${mode} button must be placed inside a form container`,
      { ...context.location, propertyPath: ["action_kind"] },
    );

  const label = context.accessibleName ?? props.metadata.name;
  const pending = context.pending || running || (mode === "submit" && form?.pending === true);
  const disabled =
    context.inactive ||
    pending ||
    settings.boolean("disabled") ||
    (mode !== "action" && form?.inactive === true);
  const note = context.unavailable ? "Unavailable" : context.disabledReason;

  return (
    <>
      <button
        type={mode === "action" ? "button" : mode}
        data-vortex-control="button"
        data-vortex-placement-id={props.placementId}
        data-vortex-action-kind={mode}
        data-vortex-variant={variant}
        disabled={disabled}
        aria-busy={pending}
        {...(note === undefined ? {} : { "aria-describedby": noteId })}
        onClick={() => {
          if (mode !== "action" || disabled) return;
          const outcome: unknown = context.events?.action?.({ event: "action", intent: "activate" });
          if (outcome instanceof Promise) {
            setRunning(true);
            const settle = (): void => {
              if (mounted.current) setRunning(false);
            };
            outcome.then(settle, settle);
          }
        }}
        className={`vortex-button vortex-button-${variant}`}
      >
        {label}
      </button>
      {note === undefined ? null : (
        <span id={noteId} className="vortex-field-note">
          {note}
        </span>
      )}
    </>
  );
}
