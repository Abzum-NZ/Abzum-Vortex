"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactElement,
  type RefObject,
} from "react";
import { Notice } from "../components/notice";
import { toast } from "../components/sonner";
import { performNavigateTask } from "../launcher/link-navigation";
import type {
  FlowConfirmAnswer,
  FlowFormAnswer,
  FlowIntentHost,
  FlowMessageAction,
  FlowMessageIntent,
} from "./intents";
import { isBackAnswer, surfaceCancellationError } from "./intents";
import { createWizardStore, SurfaceScreen, WizardWorking, type WizardStore } from "./flow-surfaces";
import type { Answered, FlowIntentHostOptions, Surface } from "./flow-surface-types";
import type { FlowRuntimeState } from "./flow-runtime";
import type { PageMessageTarget } from "./messages";

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

/**
 * Flow toasts go through the one sonner region at the bottom-right, exactly like every other toast
 * in the product, and never over a page header's actions. The page runtime keeps the message while a
 * page change carries it, so a carried toast shows once with the same identity and keeps its timer.
 */
function FlowToastRegion({ state }: Readonly<{ state: FlowRuntimeState }>): null {
  const message = useSyncExternalStore(
    (listener) => state.subscribe(`message:${state.messages.key("toast")}`, listener),
    () => state.messages.read("toast"),
    () => undefined,
  );
  const messageId = message?.id;
  useEffect(() => {
    if (messageId === undefined || message === undefined) return;
    toast.custom(
      () => (
        <Notice
          severity={message.severity}
          content={message.text}
          dismissible
          onDismiss={() => state.messages.clear("toast", undefined, message.id)}
          {...(message.title === undefined ? {} : { title: message.title })}
          {...(message.action === undefined ? {} : { action: message.action })}
        />
      ),
      {
        id: message.id,
        duration: message.dismissAfterMs ?? 5_000,
        dismissible: true,
      },
    );
    return () => {
      toast.dismiss(message.id);
    };
  }, [message, messageId, state]);
  return null;
}

/** Only this subtree re-renders when a flow opens or closes a surface. */
function FlowSurfaceHost({
  queue,
  wizards,
  optionsRef,
  start,
}: Readonly<{
  queue: SurfaceQueue;
  wizards: WizardStore;
  optionsRef: RefObject<FlowIntentHostOptions>;
  start: (message: FlowMessageIntent, action: FlowMessageAction, chain: number) => void;
}>): ReactElement | null {
  const current = useSyncExternalStore(queue.subscribe, queue.snapshot, () => null);
  const wizard = useSyncExternalStore(wizards.subscribe, wizards.snapshot, () => null);
  const leave = optionsRef.current.guidedLeaveLabel ?? "Close";
  if (current !== null)
    return (
      <SurfaceScreen
        key={current.id}
        current={current}
        options={optionsRef.current}
        start={(message, action) => start(message, action, current.chain)}
        // Guided steps wrap only the dialogs of the run chain that opened them.
        wizard={wizard !== null && wizard.chain === current.chain ? wizard : null}
        onLeave={wizards.close}
      />
    );
  if (wizard?.working !== undefined)
    return <WizardWorking wizard={wizard} leaveLabel={leave} onLeave={wizards.close} />;
  return null;
}

/** One run chain: the runs that hand over to one another, the dialogs they open and where Back leads. */
type Chain = {
  readonly id: number;
  runs: number;
  stood: ReturnType<WizardStore["snapshot"]>[];
};

/** Presents flow intents without re-rendering the page when a surface changes. */
export function useFlowIntentHost(
  options: FlowIntentHostOptions,
): Readonly<{ host: FlowIntentHost; element: ReactElement; banner: ReactElement }> {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const queue = useMemo(() => createSurfaceQueue(), []);
  const wizards = useMemo(() => createWizardStore(), []);
  useEffect(
    () => () => {
      queue.abandon();
      wizards.close();
    },
    [queue, wizards],
  );
  const { host, start } = useMemo(() => {
    let nextChain = 0;
    const chains = new Map<number, Chain>();
    const chainOf = (id: number | undefined): Chain => {
      const held = id === undefined ? undefined : chains.get(id);
      if (held !== undefined) return held;
      const created: Chain = { id: (nextChain += 1), runs: 0, stood: [] };
      chains.set(created.id, created);
      return created;
    };
    // The chain a run started by a message action joins, taken by the run's host as it starts.
    let inherit: number | undefined;
    const hostFor = (chain: Chain): FlowIntentHost => {
      const trackRun: NonNullable<FlowIntentHost["trackRun"]> = (run) => {
        chain.runs += 1;
        return run.finally(() => {
          chain.runs -= 1;
          if (chain.runs > 0) return;
          // The last run of the chain has ended: its steps and its way back go with it.
          chain.stood = [];
          chains.delete(chain.id);
          if (queue.snapshot()?.chain !== chain.id) wizards.closeChain(chain.id);
        });
      };
      const ask = async <Answer extends object>(
        build: (id: number, settle: (answer: Answered<Answer>) => void) => Surface,
        signal?: AbortSignal,
      ): Promise<Answered<Answer>> => {
        wizards.clearWorking();
        chain.stood.push(wizards.snapshot());
        const answer = await queue.enqueue<Answered<Answer>>(build, signal);
        if (isBackAnswer(answer)) {
          // Back to the dialog before this one: the steps stand where they did when it was shown,
          // and showing it again records that place once more.
          chain.stood.pop();
          const earlier = chain.stood.pop();
          if (earlier !== undefined) wizards.restore(earlier);
        }
        return answer;
      };
      return {
        showMessage: (message, signal) => {
          const state = optionsRef.current.state;
          const id = crypto.randomUUID();
          const offeredAction = message.actions?.find(
            (action) => optionsRef.current.actionOffered?.(action) !== false,
          );
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
            // Outside a dialog a message offers one action.
            ...(offeredAction === undefined
              ? {}
              : {
                  action: {
                    kind: "flow" as const,
                    label: offeredAction.label,
                    run: () => void optionsRef.current.onMessageAction(message, offeredAction),
                  },
                }),
          });
          if (message.target !== "dialog") return;
          wizards.clearWorking();
          return queue
            .enqueue<void>(
              (surfaceId, settle) => ({
                id: surfaceId,
                chain: chain.id,
                kind: "message",
                message,
                settle,
              }),
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
          ask<FlowFormAnswer>(
            (id, settle) => ({ id, chain: chain.id, kind: "form", form, settle }),
            signal,
          ),
        confirm: (confirmation, signal) =>
          ask<FlowConfirmAnswer>(
            (id, settle) => ({ id, chain: chain.id, kind: "confirm", confirmation, settle }),
            signal,
          ),
        verify: async (verification, signal) => {
          const checker = optionsRef.current.verification;
          if (checker === undefined) throw new Error("FLOW_VERIFY_UNAVAILABLE");
          // A proof the person already gave recently is not asked for again.
          if ((await checker.status(verification.requires, signal)) === "satisfied")
            return { confirmed: true, asked: false };
          return ask<FlowConfirmAnswer>(
            (id, settle) => ({ id, chain: chain.id, kind: "verify", verification, settle }),
            signal,
          );
        },
        wizard: (wizard) => wizards.set(wizard, chain.id),
        trackRun,
        forRun: () => {
          const joined = chainOf(inherit);
          inherit = undefined;
          return hostFor(joined);
        },
        navigate: (intent) => performNavigateTask(intent, optionsRef.current.navigation),
        refresh: (component) => optionsRef.current.refresh?.(component),
        setPanel: (panel, state) => optionsRef.current.setPanel?.(panel, state),
        setFilter: (component, field, value) =>
          optionsRef.current.setFilter?.(component, field, value),
      };
    };
    /** A message action starts its flow in the same chain; the dialog waits for it and says so. */
    const startAction = (
      message: FlowMessageIntent,
      action: FlowMessageAction,
      chain: number,
    ): void => {
      wizards.working(`${action.label}…`);
      inherit = chain;
      try {
        void optionsRef.current.onMessageAction(message, action);
      } finally {
        inherit = undefined;
      }
    };
    return { host: hostFor(chainOf(undefined)), start: startAction };
  }, [queue, wizards]);
  const element = (
    <>
      <FlowToastRegion state={options.state} />
      <FlowSurfaceHost queue={queue} wizards={wizards} optionsRef={optionsRef} start={start} />
    </>
  );
  return { host, element, banner: <MessageTarget state={options.state} target="banner" /> };
}
