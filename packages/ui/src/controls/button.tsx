"use client";

import { useContext, useEffect, useId, useRef, type ReactElement } from "react";
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
import { usePlacementReactions } from "../flow-runtime/placement-reactions";
import { FlowRuntimeStateContext } from "../flow-runtime/flow-runtime-state-context";

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
  const submitActionHostRef = useRef<HTMLDivElement>(null);
  const reactions = usePlacementReactions();
  const noteId = useId();
  // The shared scheduler decides whether another action queues, supersedes or is ignored.
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
    reactions.readOnly === true ||
    (mode !== "action" && pending) ||
    settings.boolean("disabled") ||
    (mode !== "action" && form?.inactive === true);
  const note = context.unavailable ? "Unavailable" : context.disabledReason;
  const click = (): void => {
    if (mode !== "action" || disabled) return;
    gesture.track(
      context.events?.action?.({
        event: "action",
        intent: "activate",
        ...(form === undefined ? {} : { readValues: form.values }),
      }),
    );
  };
  // An agent uses the button as the person does: its click, or its form's one submit or reset path.
  const agentState = useRef({ click, disabled, hidden: reactions.visible === false, form, mode });
  agentState.current = { click, disabled, hidden: reactions.visible === false, form, mode };
  // The registry is the page's one agent registry; a host may wrap the runtime state per render.
  const agent = useContext(FlowRuntimeStateContext)?.agent;
  const registerSubmitActions = form?.registerSubmitActions;
  useEffect(() => {
    if (mode !== "submit" || registerSubmitActions === undefined) return;
    const host = submitActionHostRef.current;
    return host === null ? undefined : registerSubmitActions(host);
  }, [mode, registerSubmitActions]);
  useEffect(
    () =>
      agent?.register({
        kind: "button",
        id: props.placementId,
        label,
        formId: mode === "action" ? undefined : form?.formId,
        refusal: () =>
          agentState.current.hidden
            ? "hidden"
            : agentState.current.disabled
              ? "disabled"
              : undefined,
        activate: () => {
          const current = agentState.current;
          if (current.mode === "submit") current.form?.submit();
          else if (current.mode === "reset") current.form?.reset();
          else current.click();
        },
      }),
    [agent, form?.formId, label, mode, props.placementId],
  );

  const button = (
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
        onClick={click}
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
  return mode === "submit" ? (
    <div ref={submitActionHostRef} data-vortex-form-actions="">
      {button}
    </div>
  ) : (
    button
  );
}
