"use client";

import { useEffect, useId, type ReactElement, type ReactNode, type RefObject } from "react";
import { Button } from "../components/button";
import { Checkbox } from "../components/checkbox";
import { useConfirm } from "../components/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/dialog";
import type { FlowConfirmAnswer, FlowConfirmIntent } from "./intents";
import { FlowSurfaceContext } from "./flow-surface-context";
import type { FlowIntentHostOptions, Surface } from "./flow-intent-host";

/** Flow surface width, the same 36rem the theme's medium dialog scale used. */
const FLOW_SURFACE_CLASS = "max-h-[calc(100%-2rem)] overflow-y-auto sm:max-w-xl";

/**
 * One modal flow surface on the shadcn Dialog (Base UI), like every other surface in the product.
 * The primitive traps focus inside the surface, makes the rest of the page inert and returns focus
 * to the element that had it when the surface opened, and the title it renders is the surface's
 * accessible name. Escape is the only way the primitive can dismiss a surface, because a press
 * outside it is not a dismissal; every dismissal settles the surface exactly as the person's own
 * answer would, so a flow run is never left waiting on a surface that has gone.
 */
function FlowDialog({
  title,
  onDismiss,
  actions,
  children,
}: Readonly<{
  title: string;
  onDismiss: () => void;
  actions?: ReactNode;
  children: ReactNode;
}>): ReactElement {
  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onDismiss();
      }}
    >
      <DialogContent
        showCloseButton={false}
        data-vortex-flow-surface="true"
        className={FLOW_SURFACE_CLASS}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <FlowSurfaceContext.Provider value={true}>
          <div>{children}</div>
        </FlowSurfaceContext.Provider>
        {actions === undefined ? null : <DialogFooter>{actions}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}

/**
 * A confirmation: its message, the lines it covers, and its one opt-in, which starts unticked for
 * every prompt and counts only with a yes. Any dismissal is a no.
 */
function ConfirmSurface({
  confirmation,
  settle,
}: Readonly<{
  confirmation: FlowConfirmIntent;
  settle: (answer: FlowConfirmAnswer) => void;
}>): ReactElement {
  const [confirm, dialog] = useConfirm();
  const choiceId = useId();
  useEffect(() => {
    let mounted = true;
    let choice = false;
    void confirm({
      title: confirmation.title ?? "Confirm",
      description: confirmation.message,
      confirmLabel: confirmation.confirmLabel ?? "Confirm",
      ...(confirmation.destructive === undefined ? {} : { destructive: confirmation.destructive }),
      details: (
        <div className="flex flex-col gap-3">
          {confirmation.details.length === 0 ? null : (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
              {confirmation.details.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          )}
          {confirmation.choice === undefined ? null : (
            <div className="flex items-start gap-2 text-sm">
              <Checkbox
                id={choiceId}
                defaultChecked={false}
                onCheckedChange={(checked) => {
                  choice = checked === true;
                }}
              />
              <label htmlFor={choiceId}>{confirmation.choice}</label>
            </div>
          )}
        </div>
      ),
    }).then((confirmed) => {
      if (mounted)
        settle(
          confirmed && confirmation.choice !== undefined ? { confirmed, choice } : { confirmed },
        );
    });
    return () => {
      mounted = false;
    };
  }, [confirm, confirmation, settle, choiceId]);
  return dialog;
}

/** Only this subtree re-renders when a flow opens or closes a surface. */
export default function FlowSurfaceView({
  current,
  optionsRef,
}: Readonly<{
  current: Surface;
  optionsRef: RefObject<FlowIntentHostOptions>;
}>): ReactElement | null {
  if (current?.kind === "message") {
    const { message, settle } = current;
    return (
      <FlowDialog
        key={current.id}
        title={message.title}
        onDismiss={() => settle()}
        actions={
          <Button type="button" onClick={() => settle()}>
            OK
          </Button>
        }
      >
        <p role="status">{message.text}</p>
      </FlowDialog>
    );
  }
  if (current?.kind === "confirm")
    return (
      <ConfirmSurface
        key={current.id}
        confirmation={current.confirmation}
        settle={current.settle}
      />
    );
  if (current?.kind === "form") {
    const { form, settle } = current;
    const rendered = optionsRef.current.renderForm(form, {
      submit: (values, choiceEvidence) =>
        settle({
          kind: "submit",
          values,
          ...(choiceEvidence === undefined ? {} : { choiceEvidence }),
        }),
      cancel: () => settle({ kind: "cancel" }),
    });
    return (
      <FlowDialog
        key={current.id}
        title={rendered.title}
        onDismiss={() => settle({ kind: "cancel" })}
      >
        {rendered.body}
      </FlowDialog>
    );
  }
  return null;
}
