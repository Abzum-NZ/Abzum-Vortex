"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { LinkNavigationEnvironment } from "../launcher/link-navigation";
import { performNavigateTask } from "../launcher/link-navigation";
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
    controls: Readonly<{ submit: (values: FlowFormAnswer["values"]) => void; cancel: () => void }>,
  ) => ReactNode;
  navigation: LinkNavigationEnvironment;
  refresh?: FlowIntentHost["refresh"];
  setPanel?: FlowIntentHost["setPanel"];
  setFilter?: FlowIntentHost["setFilter"];
}>;

/** A modal surface on the native `<dialog>`: focus moves in, Tab stays inside, Escape dismisses. */
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
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const surface = ref.current;
    const previous = document.activeElement;
    if (surface !== null && !surface.open) surface.showModal();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className="vortex-dialog"
      data-vortex-flow-surface="true"
      style={{ width: "min(36rem, calc(100% - 2rem))", maxHeight: "calc(100% - 2rem)" }}
      onCancel={(event) => {
        event.preventDefault();
        onDismiss();
      }}
    >
      <div className="vortex-dialog-header">
        <h2 id={titleId} className="vortex-dialog-title">
          {title}
        </h2>
      </div>
      <div className="vortex-dialog-body">{children}</div>
      {actions === undefined ? null : <div className="vortex-dialog-actions">{actions}</div>}
    </dialog>
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

  const enqueue = useCallback(<Result,>(build: (id: number, settle: (result: Result) => void) => Surface) => {
    return new Promise<Result>((resolve) => {
      const id = (nextId.current += 1);
      const surface = build(id, (result) => {
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
          <button type="button" className="vortex-button vortex-button-primary" onClick={() => settle()}>
            OK
          </button>
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
            <button
              type="button"
              className="vortex-button vortex-button-secondary"
              onClick={() => settle(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="vortex-button vortex-button-primary"
              onClick={() => settle(true)}
            >
              Confirm
            </button>
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
        onDismiss={() => settle({ submitted: false, values: null })}
      >
        {options.renderForm(form, {
          submit: (values) => settle({ submitted: true, values }),
          cancel: () => settle({ submitted: false, values: null }),
        })}
      </FlowDialog>
    );
  }
  return { host, element };
}
