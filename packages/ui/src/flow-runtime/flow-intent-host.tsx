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
import type { ReferenceChoiceSelectionEvidenceMap } from "@vortex/platform/schema";
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
      submit: (
        values: Extract<FlowFormAnswer, { kind: "submit" }>["values"],
        choiceEvidence?: ReferenceChoiceSelectionEvidenceMap,
      ) => void;
      cancel: () => void;
    }>,
  ) => Readonly<{ title: string; body: ReactNode }>;
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

/** Presents flow intents without re-rendering the page when a surface changes. */
export function useFlowIntentHost(
  options: FlowIntentHostOptions,
): Readonly<{ host: FlowIntentHost; element: ReactElement }> {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const queue = useMemo(() => createSurfaceQueue(), []);
  useEffect(() => () => queue.abandon(), [queue]);
  const host = useMemo<FlowIntentHost>(
    () => ({
      showMessage: (message, signal) =>
        queue.enqueue<void>((id, settle) => ({ id, kind: "message", message, settle }), signal),
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
  const element = useMemo(() => <FlowSurfaceHost queue={queue} optionsRef={optionsRef} />, [queue]);
  return { host, element };
}
