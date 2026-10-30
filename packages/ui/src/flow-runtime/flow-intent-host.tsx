"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactElement,
  type RefObject,
  type ReactNode,
} from "react";
import { Button } from "../components/button";
import { Notice } from "../components/notice";
import { Checkbox } from "../components/checkbox";
import { useConfirm } from "../components/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/dialog";
import type { LinkNavigationEnvironment } from "../launcher/link-navigation";
import { performNavigateTask } from "../launcher/link-navigation";
import type {
  FlowConfirmAnswer,
  FlowConfirmIntent,
  FlowFormAnswer,
  FlowFormIntent,
  FlowIntentHost,
  FlowMessageIntent,
} from "./intents";
import { surfaceCancellationError } from "./intents";
import { FlowSurfaceContext } from "./flow-surface-context";
import type { FlowRuntimeState } from "./flow-runtime";
import type { PageMessageTarget } from "./messages";

type Surface =
  | Readonly<{ id: number; kind: "message"; message: FlowMessageIntent; settle: () => void }>
  | Readonly<{
      id: number;
      kind: "confirm";
      confirmation: FlowConfirmIntent;
      settle: (answer: FlowConfirmAnswer) => void;
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
   * shell supplies its title and body and calls `submit` with the typed values or `cancel` when dismissed.
   */
  renderForm: (
    form: FlowFormIntent,
    controls: Readonly<{
      submit: (values: Extract<FlowFormAnswer, { kind: "submit" }>["values"]) => void;
      cancel: () => void;
    }>,
  ) => Readonly<{ title: string; body: ReactNode }>;
  navigation: LinkNavigationEnvironment;
  state: FlowRuntimeState;
  onMessageAction: (message: FlowMessageIntent) => void;
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

/** The modal queue notifies only its own surface, keeping the page renderer independent. */
function createSurfaceQueue() {
  let surfaces: readonly Surface[] = [];
  let nextId = 0;
  const listeners = new Set<() => void>();
  const pending = new Map<number, () => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const remove = (id: number): void => {
    const before = surfaces[0];
    surfaces = surfaces.filter((entry) => entry.id !== id);
    if (before !== surfaces[0]) notify();
  };
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => surfaces[0] ?? null,
    abandon: () => {
      for (const cancel of [...pending.values()]) cancel();
      pending.clear();
    },
    enqueue: <Result,>(
      build: (id: number, settle: (result: Result) => void) => Surface,
      signal?: AbortSignal,
    ): Promise<Result> =>
      new Promise<Result>((resolve, reject) => {
        const id = (nextId += 1);
        const cancel = (reason: unknown): void => {
          if (!pending.delete(id)) return;
          signal?.removeEventListener("abort", abort);
          remove(id);
          reject(reason);
        };
        const abort = (): void => cancel(signal?.reason ?? surfaceCancellationError());
        if (signal?.aborted) {
          reject(signal.reason ?? surfaceCancellationError());
          return;
        }
        pending.set(id, () => cancel(surfaceCancellationError()));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
          abort();
          return;
        }
        const surface = build(id, (result) => {
          if (!pending.delete(id)) return;
          signal?.removeEventListener("abort", abort);
          remove(id);
          resolve(result);
        });
        if (pending.has(id)) {
          const wasEmpty = surfaces.length === 0;
          surfaces = [...surfaces, surface];
          if (wasEmpty) notify();
        }
      }),
  };
}

type SurfaceQueue = ReturnType<typeof createSurfaceQueue>;

function MessageTarget({
  state,
  target,
}: Readonly<{ state: FlowRuntimeState; target: PageMessageTarget }>): ReactElement | null {
  const message = useSyncExternalStore(
    (listener) => state.subscribe(`message:${state.messages.key(target)}`, listener),
    () => state.messages.read(target),
    () => undefined,
  );
  if (message === undefined) return null;
  return (
    <Notice
      key={message.id}
      severity={message.severity}
      content={message.text}
      dismissible
      onDismiss={() => state.messages.clear(target, undefined, message.id)}
      {...(message.title === undefined ? {} : { title: message.title })}
      {...(message.action === undefined ? {} : { action: message.action })}
    />
  );
}

/** Only this subtree re-renders when a flow opens or closes a surface. */
function FlowSurfaceHost({
  queue,
  optionsRef,
}: Readonly<{
  queue: SurfaceQueue;
  optionsRef: RefObject<FlowIntentHostOptions>;
}>): ReactElement | null {
  const current = useSyncExternalStore(queue.subscribe, queue.snapshot, () => null);
  if (current?.kind === "message") {
    const { message, settle } = current;
    return (
      <FlowDialog
        key={current.id}
        title={message.title ?? "Message"}
        onDismiss={() => settle()}
        actions={
          <>
            {message.actionLabel === undefined ? null : (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  settle();
                  optionsRef.current.onMessageAction(message);
                }}
              >
                {message.actionLabel}
              </Button>
            )}
            <Button type="button" onClick={() => settle()}>
              OK
            </Button>
          </>
        }
      >
        <p
          role={message.severity === "warning" || message.severity === "error" ? "alert" : "status"}
          aria-live={
            message.severity === "warning" || message.severity === "error" ? "assertive" : "polite"
          }
        >
          {message.text}
        </p>
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
      submit: (values) => settle({ kind: "submit", values }),
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

/** Presents flow intents without re-rendering the page when a surface changes. */
export function useFlowIntentHost(
  options: FlowIntentHostOptions,
): Readonly<{ host: FlowIntentHost; element: ReactElement; banner: ReactElement }> {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const queue = useMemo(() => createSurfaceQueue(), []);
  useEffect(() => () => queue.abandon(), [queue]);
  const host = useMemo<FlowIntentHost>(
    () => ({
      showMessage: (message, signal) => {
        const state = optionsRef.current.state;
        const id = crypto.randomUUID();
        state.messages.show({
          id,
          target: message.target,
          severity: message.severity,
          text: message.text,
          ...(message.component === undefined ? {} : { component: message.component }),
          ...(message.title === undefined ? {} : { title: message.title }),
          ...(message.dismissAfterMs === undefined
            ? {}
            : { dismissAfterMs: message.dismissAfterMs }),
          ...(message.actionLabel === undefined
            ? {}
            : {
                action: {
                  kind: "flow" as const,
                  label: message.actionLabel,
                  run: () => optionsRef.current.onMessageAction(message),
                },
              }),
        });
        if (message.target !== "dialog") return;
        return queue
          .enqueue<void>(
            (surfaceId, settle) => ({ id: surfaceId, kind: "message", message, settle }),
            signal,
          )
          .finally(() => state.messages.clear("dialog", undefined, id));
      },
      clearMessage: (target, component) => {
        optionsRef.current.state.messages.clear(target, component);
        const current = queue.snapshot();
        if (target === "dialog" && current?.kind === "message") current.settle();
      },
      showForm: (form, signal) =>
        queue.enqueue<FlowFormAnswer>((id, settle) => ({ id, kind: "form", form, settle }), signal),
      confirm: (confirmation, signal) =>
        queue.enqueue<FlowConfirmAnswer>(
          (id, settle) => ({ id, kind: "confirm", confirmation, settle }),
          signal,
        ),
      navigate: (intent) => performNavigateTask(intent, optionsRef.current.navigation),
      refresh: (component) => optionsRef.current.refresh?.(component),
      setPanel: (panel, state) => optionsRef.current.setPanel?.(panel, state),
      setFilter: (component, field, value) =>
        optionsRef.current.setFilter?.(component, field, value),
    }),
    [queue],
  );
  const element = (
    <>
      <div className="fixed right-4 top-4 z-50">
        <MessageTarget state={options.state} target="toast" />
      </div>
      <FlowSurfaceHost queue={queue} optionsRef={optionsRef} />
    </>
  );
  return { host, element, banner: <MessageTarget state={options.state} target="banner" /> };
}
