"use client";

import { useId, useState, type ReactElement, type ReactNode } from "react";
import { Button } from "../components/button";
import { Checkbox } from "../components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/dialog";
import { Progress } from "../components/progress";
import { Spinner } from "../components/spinner";
import { FlowSurfaceContext } from "./flow-surface-context";
import { InlineFormFields } from "./inline-form-surface";
import type { Answered, FlowIntentHostOptions, Surface, Wizard } from "./flow-surface-types";
import type {
  FlowConfirmationDetail,
  FlowConfirmAnswer,
  FlowConfirmIntent,
  FlowMessageAction,
  FlowMessageIntent,
  FlowVerifyIntent,
  FlowWizardIntent,
} from "./intents";

/** Flow surface width, the same 36rem the theme's medium dialog scale used. */
const FLOW_SURFACE_CLASS = "sm:max-w-xl";

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
  guided,
}: Readonly<{
  title: string;
  onDismiss: () => void;
  actions?: ReactNode;
  children: ReactNode;
  /** The guided steps' dialog, which shows where the person is in them above the screen. */
  guided?: Wizard;
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
        {...(guided === undefined ? {} : { "data-vortex-flow-wizard": "true" })}
        className={FLOW_SURFACE_CLASS}
      >
        <DialogHeader>
          <DialogTitle>{guided === undefined ? title : guided.title}</DialogTitle>
        </DialogHeader>
        {guided === undefined ? null : <WizardProgress wizard={guided} />}
        <FlowSurfaceContext.Provider value={true}>
          <div className="flex flex-col gap-3">
            {guided === undefined ? null : <p className="text-sm font-medium">{title}</p>}
            {children}
          </div>
        </FlowSurfaceContext.Provider>
        {actions === undefined || actions === null ? null : <DialogFooter>{actions}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The guided steps, shared by every flow run of this shell: they open with a flow's first Guided
 * steps step, follow it from step to step and close once no run is left and no dialog is up.
 */
export function createWizardStore() {
  let wizard: Wizard | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => wizard,
    /** Moves to a step; what the flow is working on is cleared by the next dialog. */
    set: (next: FlowWizardIntent) => {
      wizard = { ...next };
      notify();
    },
    /** Puts the guided steps back where they stood (or closes them), when the person goes back. */
    restore: (earlier: Wizard | null) => {
      wizard = earlier === null ? null : { ...earlier, working: undefined };
      notify();
    },
    working: (text: string) => {
      if (wizard === null) return;
      wizard = { ...wizard, working: text };
      notify();
    },
    clearWorking: () => {
      if (wizard === null || wizard.working === undefined) return;
      wizard = { ...wizard, working: undefined };
      notify();
    },
    close: () => {
      if (wizard === null) return;
      wizard = null;
      notify();
    },
  };
}

export type WizardStore = ReturnType<typeof createWizardStore>;

/** The step indicator: where the person is among the steps, as a bar and in words. */
function WizardProgress({ wizard }: Readonly<{ wizard: Wizard }>): ReactElement {
  const position = Math.max(0, wizard.steps.indexOf(wizard.step)) + 1;
  const where = `Step ${position} of ${wizard.steps.length}`;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{where}</span>
        <span className="text-muted-foreground">{wizard.step}</span>
      </div>
      <Progress value={(position / wizard.steps.length) * 100} aria-label={where} />
    </div>
  );
}

/** Between two dialogs the guided steps say what the flow is doing, so the person is never left guessing. */
export function WizardWorking({ wizard }: Readonly<{ wizard: Wizard }>): ReactElement {
  return (
    <FlowDialog title={wizard.step} onDismiss={() => undefined} guided={wizard}>
      <div className="flex items-center gap-3 py-2 text-sm" role="status" aria-live="polite">
        <Spinner />
        <span>{wizard.working}</span>
      </div>
    </FlowDialog>
  );
}

/** Goes back one step; it sits first in the row so it stays at the edge away from the answer. */
function BackButton({ onBack }: Readonly<{ onBack: () => void }>): ReactElement {
  return (
    <Button type="button" variant="ghost" className="sm:mr-auto" onClick={onBack}>
      Back
    </Button>
  );
}

/** Shows every review line; a role entry lists what it allows under its own line. */
// item 10: CRM-FIX-PLATFORM
const ConfirmationDetails = ({
  entries,
}: Readonly<{ entries: readonly FlowConfirmationDetail[] }>): ReactElement => (
  <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
    {entries.map((entry, index) =>
      typeof entry === "string" ? (
        <li key={index}>{entry}</li>
      ) : (
        <li key={index}>
          {entry.text}
          {/* item 10: CRM-FIX-PLATFORM */}
          <ul className="flex list-[circle] flex-col gap-1 pl-5">
            {entry.lines.map((line, lineIndex) => (
              <li key={lineIndex}>{line}</li>
            ))}
          </ul>
        </li>
      ),
    )}
  </ul>
);

/**
 * A confirmation: its message, the lines it covers, and its one opt-in, which starts unticked for
 * every prompt and counts only with a yes. Any dismissal is a no.
 */
function ConfirmScreen({
  confirmation,
  settle,
  wizard,
}: Readonly<{
  confirmation: FlowConfirmIntent;
  settle: (answer: Answered<FlowConfirmAnswer>) => void;
  wizard: Wizard | null;
}>): ReactElement {
  const choiceId = useId();
  const [choice, setChoice] = useState(false);
  return (
    <FlowDialog
      title={confirmation.title ?? "Confirm"}
      onDismiss={() => settle({ confirmed: false })}
      {...(wizard === null ? {} : { guided: wizard })}
      actions={
        <>
          {wizard !== null && confirmation.back === true ? (
            <BackButton onBack={() => settle({ back: true })} />
          ) : null}
          <Button type="button" variant="outline" onClick={() => settle({ confirmed: false })}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={confirmation.destructive === true ? "destructive" : "default"}
            onClick={() =>
              settle(
                confirmation.choice === undefined
                  ? { confirmed: true }
                  : { confirmed: true, choice },
              )
            }
          >
            {confirmation.confirmLabel ?? "Confirm"}
          </Button>
        </>
      }
    >
      <DialogDescription className="whitespace-pre-line">{confirmation.message}</DialogDescription>
      {confirmation.details.length === 0 ? null : (
        <div className="max-h-80 overflow-y-auto">
          {/* item 10: CRM-FIX-PLATFORM */}
          <ConfirmationDetails entries={confirmation.details} />
        </div>
      )}
      {confirmation.choice === undefined ? null : (
        <div className="flex items-start gap-2 text-sm">
          <Checkbox
            id={choiceId}
            checked={choice}
            onCheckedChange={(checked) => setChoice(checked === true)}
          />
          <label htmlFor={choiceId}>{confirmation.choice}</label>
        </div>
      )}
    </FlowDialog>
  );
}

/** A verification: the shell's challenge inside the step, and on to the flow once the person has given the proof. */
function VerifyScreen({
  verification,
  settle,
  options,
  wizard,
}: Readonly<{
  verification: FlowVerifyIntent;
  settle: (answer: Answered<FlowConfirmAnswer>) => void;
  options: FlowIntentHostOptions;
  wizard: Wizard | null;
}>): ReactElement {
  return (
    <FlowDialog
      title="Verify it is you"
      onDismiss={() => settle({ confirmed: false })}
      {...(wizard === null ? {} : { guided: wizard })}
      actions={
        <>
          {wizard !== null && verification.back === true ? (
            <BackButton onBack={() => settle({ back: true })} />
          ) : null}
          <Button type="button" variant="outline" onClick={() => settle({ confirmed: false })}>
            Cancel
          </Button>
        </>
      }
    >
      <DialogDescription>{verification.message}</DialogDescription>
      {options.verification?.render(verification.requires, {
        verified: () => settle({ confirmed: true }),
      })}
    </FlowDialog>
  );
}

/** A dialog message: its text and its actions, each a flow it starts. */
function MessageScreen({
  message,
  settle,
  options,
  start,
  wizard,
}: Readonly<{
  message: FlowMessageIntent;
  settle: () => void;
  options: FlowIntentHostOptions;
  start: (message: FlowMessageIntent, action: FlowMessageAction) => void;
  wizard: Wizard | null;
}>): ReactElement {
  const offered = (message.actions ?? []).filter(
    (action) => options.actionOffered?.(action) !== false,
  );
  const urgent = message.severity === "warning" || message.severity === "error";
  return (
    <FlowDialog
      title={message.title ?? "Message"}
      onDismiss={() => settle()}
      {...(wizard === null ? {} : { guided: wizard })}
      actions={
        <>
          {offered.map((action) => (
            <Button
              key={`${action.flow}:${action.label}`}
              type="button"
              variant={wizard === null ? "secondary" : "default"}
              onClick={() => {
                settle();
                start(message, action);
              }}
            >
              {action.label}
            </Button>
          ))}
          <Button
            type="button"
            variant={wizard !== null && offered.length > 0 ? "secondary" : "default"}
            onClick={() => settle()}
          >
            {wizard === null ? "OK" : (options.guidedLeaveLabel ?? "Close")}
          </Button>
        </>
      }
    >
      <p
        className="text-sm"
        role={urgent ? "alert" : "status"}
        aria-live={urgent ? "assertive" : "polite"}
      >
        {message.text}
      </p>
    </FlowDialog>
  );
}

/** The surface at the head of the queue: its own dialog, or the next screen of the guided steps when some are open. */
export function SurfaceScreen({
  current,
  options,
  start,
  wizard,
}: Readonly<{
  current: Surface;
  options: FlowIntentHostOptions;
  start: (message: FlowMessageIntent, action: FlowMessageAction) => void;
  wizard: Wizard | null;
}>): ReactElement {
  switch (current.kind) {
    case "message":
      return (
        <MessageScreen
          message={current.message}
          settle={current.settle}
          options={options}
          start={start}
          wizard={wizard}
        />
      );
    case "confirm":
      return (
        <ConfirmScreen
          confirmation={current.confirmation}
          settle={current.settle}
          wizard={wizard}
        />
      );
    case "verify":
      return (
        <VerifyScreen
          verification={current.verification}
          settle={current.settle}
          options={options}
          wizard={wizard}
        />
      );
    case "form": {
      const { form, settle } = current;
      if ("fields" in form)
        return (
          <FlowDialog
            title={form.title ?? "Details"}
            onDismiss={() => settle({ kind: "cancel" })}
            {...(wizard === null ? {} : { guided: wizard })}
          >
            <InlineFormFields
              form={form}
              onSubmit={(values) => settle({ kind: "submit", values })}
              onCancel={() => settle({ kind: "cancel" })}
              {...(wizard !== null && form.back === true
                ? { onBack: () => settle({ back: true }) }
                : {})}
            />
          </FlowDialog>
        );
      const rendered = options.renderForm(form, {
        submit: (values) => settle({ kind: "submit", values }),
        cancel: () => settle({ kind: "cancel" }),
      });
      return (
        <FlowDialog
          title={rendered.title}
          onDismiss={() => settle({ kind: "cancel" })}
          {...(wizard === null ? {} : { guided: wizard })}
        >
          {rendered.body}
        </FlowDialog>
      );
    }
  }
}
