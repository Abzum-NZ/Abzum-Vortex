"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Button } from "../components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/dialog";
import type { LinkNavigationEnvironment } from "../launcher/link-navigation";
import { performNavigateTask } from "../launcher/link-navigation";
import type { ReferenceChoiceSelectionEvidenceMap } from "@vortex/contracts";
import type {
  FlowConfirmIntent,
  FlowFormAnswer,
  FlowFormIntent,
  FlowIntentHost,
  FlowMessageIntent,
} from "./intents";

type Surface =
  | Readonly<{ id: number; kind: "message"; message: FlowMessageIntent; settle: () => void }>
  | Readonly<{
      id: number;
      kind: "confirm";
      confirmation: FlowConfirmIntent;
      settle: (confirmed: boolean) => void;
    }>
  | Readonly<{
      id: number;
      kind: "form";
      form: FlowFormIntent;
      settle: (answer: FlowFormAnswer) => void;
    }>;

export type FlowIntentHostOptions = Readonly<{
  /**
   * Renders the form a Show form task names. Forms are Application data the shell resolves, so the
   * shell supplies the body and calls `submit` with the typed values or `cancel` when dismissed.
   */
  renderForm: (
    form: FlowFormIntent,
    controls: Readonly<{
      submit: (
        values: Extract<FlowFormAnswer, { kind: "submit" }>["values"],
        choiceEvidence?: ReferenceChoiceSelectionEvidenceMap,
      ) => void;
      cancel: () => void;
    }>,
  ) => ReactNode;
  navigation: LinkNavigationEnvironment;
  refresh?: FlowIntentHost["refresh"];
  setPanel?: FlowIntentHost["setPanel"];
  setFilter?: FlowIntentHost["setFilter"];
}>;

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
        <div>{children}</div>
        {actions === undefined ? null : <DialogFooter>{actions}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Presents the interface intents of a flow: messages, confirmations and the shell's form body in
 * modal dialogs, and navigation through the one Navigate task implementation. Render `element`
 * once inside the shell and pass `host` to `createFlowRuntime`. Message text is rendered as text,
 * never as markup.
 */
export function useFlowIntentHost(
  options: FlowIntentHostOptions,
): Readonly<{ host: FlowIntentHost; element: ReactElement | null }> {
  const [surfaces, setSurfaces] = useState<readonly Surface[]>([]);
  const nextId = useRef(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // Rejects every unanswered surface, so a run whose host went away is abandoned, never left waiting.
  const abandon = useRef(new Map<number, () => void>());
  useEffect(() => {
    const pending = abandon.current;
    return () => {
      for (const reject of pending.values()) reject();
      pending.clear();
    };
  }, []);

  const enqueue = useCallback(<Result,>(build: (id: number, settle: (result: Result) => void) => Surface) => {
    return new Promise<Result>((resolve, reject) => {
      const id = (nextId.current += 1);
      abandon.current.set(id, () => reject(new Error("FLOW_SURFACE_ABANDONED")));
      const surface = build(id, (result) => {
        if (!abandon.current.delete(id)) return;
        setSurfaces((current) => current.filter((entry) => entry.id !== id));
        resolve(result);
      });
      setSurfaces((current) => [...current, surface]);
    });
  }, []);

  const host = useMemo<FlowIntentHost>(
    () => ({
      showMessage: (message) =>
        enqueue<void>((id, settle) => ({ id, kind: "message", message, settle })),
      showForm: (form) =>
        enqueue<FlowFormAnswer>((id, settle) => ({ id, kind: "form", form, settle })),
      confirm: (confirmation) =>
        enqueue<boolean>((id, settle) => ({ id, kind: "confirm", confirmation, settle })),
      navigate: (intent) => performNavigateTask(intent, optionsRef.current.navigation),
      refresh: (component) => optionsRef.current.refresh?.(component),
      setPanel: (panel, state) => optionsRef.current.setPanel?.(panel, state),
      setFilter: (component, field, value) =>
        optionsRef.current.setFilter?.(component, field, value),
    }),
    [enqueue],
  );

  const current = surfaces[0];
  let element: ReactElement | null = null;
  if (current?.kind === "message") {
    const { message, settle } = current;
    element = (
      <FlowDialog
        key={current.id}
        title={message.tone === undefined ? "Message" : `Message (${message.tone})`}
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
  } else if (current?.kind === "confirm") {
    const { confirmation, settle } = current;
    element = (
      <FlowDialog
        key={current.id}
        title={confirmation.title ?? "Confirm"}
        onDismiss={() => settle(false)}
        actions={
          <>
            <Button type="button" variant="secondary" onClick={() => settle(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={() => settle(true)}>
              Confirm
            </Button>
          </>
        }
      >
        <p>{confirmation.message}</p>
      </FlowDialog>
    );
  } else if (current?.kind === "form") {
    const { form, settle } = current;
    element = (
      <FlowDialog
        key={current.id}
        title="Form"
        onDismiss={() => settle({ kind: "cancel" })}
      >
        {options.renderForm(form, {
          submit: (values, choiceEvidence) =>
            settle({
              kind: "submit",
              values,
              ...(choiceEvidence === undefined ? {} : { choiceEvidence }),
            }),
          cancel: () => settle({ kind: "cancel" }),
        })}
      </FlowDialog>
    );
  }
  return { host, element };
}
