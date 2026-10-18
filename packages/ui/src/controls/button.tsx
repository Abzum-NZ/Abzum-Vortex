"use client";

import { useId, type ReactElement } from "react";
import { Button as SharedButton } from "../components/button";
import { Spinner } from "../components/spinner";
import { DefinitionRenderError } from "../definition-error";
import type { ButtonPayload } from "./projected-data";
import {
  readControlSettings,
  resolveControlContext,
  type ControlRenderProps,
} from "./control-context";
import { useFormScope } from "./form-context";
import { usePendingGesture } from "./pending-gesture";

export type ButtonProps = ControlRenderProps<ButtonPayload>;

type ButtonMode = "action" | "submit" | "reset";
type SharedButtonVariant = "default" | "secondary" | "destructive" | "ghost";

const SHARED_BUTTON_VARIANTS: Readonly<
  Record<"primary" | "secondary" | "danger" | "ghost", SharedButtonVariant>
> = {
  primary: "default",
  secondary: "secondary",
  danger: "destructive",
  ghost: "ghost",
};

/**
 * Button activated by pointer, Enter or Space. An action button emits only its declared
 * `action` event; inside a form container that event carries the form's current typed field
 * values, so the bound flow receives what the person entered. Submit and reset buttons must sit
 * inside a form container and emit nothing themselves: the form emits its one `form_submit` or
 * `form_reset` event, so Enter in a field and a Submit button share a single submission path.
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
  const gesture = usePendingGesture();
  if (mode !== "action" && form === undefined)
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      `A ${mode} button must be placed inside a form container`,
      { ...context.location, propertyPath: ["action_kind"] },
    );

  const label = context.accessibleName ?? props.metadata.name;
  const pending =
    context.pending || gesture.pending || (mode === "submit" && form?.pending === true);
  const disabled =
    context.inactive ||
    pending ||
    settings.boolean("disabled") ||
    (mode !== "action" && form?.inactive === true);
  const note = context.unavailable ? "Unavailable" : context.disabledReason;

  return (
    <>
      <SharedButton
        type={mode === "action" ? "button" : mode}
        variant={SHARED_BUTTON_VARIANTS[variant]}
        data-vortex-control="button"
        data-vortex-placement-id={props.placementId}
        data-vortex-action-kind={mode}
        data-vortex-variant={variant}
        disabled={disabled}
        aria-busy={pending}
        {...(note === undefined ? {} : { "aria-describedby": noteId })}
        onClick={() => {
          if (mode !== "action" || disabled || gesture.running()) return;
          gesture.track(
            context.events?.action?.({
              event: "action",
              intent: "activate",
              ...(form === undefined ? {} : { values: form.values() }),
            }),
          );
        }}
      >
        {pending ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
        {label}
      </SharedButton>
      {note === undefined ? null : (
        <span id={noteId} className="text-muted-foreground">
          {note}
        </span>
      )}
    </>
  );
}
