import type { ComponentFlowBinding, FlowBindingConcurrency } from "@vortex/platform/schema";
import type { FlowIntentHost } from "./intents";
import { driveServerFlow, type ServerDrivenResult } from "./server-driven-run";
import type { FlowInvokeClient, FlowSubjectContext } from "./server-flow-client";

export type FlowRuntimeOptions = Readonly<{
  client: FlowInvokeClient;
  host: FlowIntentHost;
  state: FlowRuntimeState;
  bindingSettings: (
    bindingId: string,
  ) => Readonly<{ controlId: string; concurrency: FlowBindingConcurrency }> | undefined;
  /**
   * Told, with the binding's identity, when a server run of that binding committed and before its
   * closing messages are shown, so the page can re-read the placements the binding writes.
   */
  committed?: (bindingId: string) => void;
}>;

/** State shared by page and agent dispatches, with subscriptions scoped to a component. */
export function createFlowRuntimeState() {
  const entries = new Map<
    string,
    { sequence: number; controller?: AbortController; tail?: Promise<void> }
  >();
  const running = new Map<string, number>();
  const listeners = new Map<string, Set<() => void>>();
  const notify = (controlId: string) => listeners.get(controlId)?.forEach((listener) => listener());
  const changeRunning = (controlId: string, amount: number) => {
    const before = running.get(controlId) ?? 0;
    const after = before + amount;
    if (after === 0) running.delete(controlId);
    else running.set(controlId, after);
    if ((before === 0) !== (after === 0)) notify(controlId);
  };
  const abandoned: ServerDrivenResult = { kind: "abandoned", unanswered: true };
  return {
    isRunning: (controlId: string) => (running.get(controlId) ?? 0) > 0,
    subscribe: (controlId: string, listener: () => void) => {
      const current = listeners.get(controlId) ?? new Set<() => void>();
      current.add(listener);
      listeners.set(controlId, current);
      return () => {
        current.delete(listener);
        if (current.size === 0) listeners.delete(controlId);
      };
    },
    run: (
      bindingId: string,
      controlId: string,
      concurrency: FlowBindingConcurrency,
      signal: AbortSignal | undefined,
      execute: (signal: AbortSignal) => Promise<ServerDrivenResult>,
    ): Promise<ServerDrivenResult> => {
      if (signal?.aborted) return Promise.resolve(abandoned);
      const entry = entries.get(bindingId) ?? { sequence: 0 };
      entries.set(bindingId, entry);
      if (concurrency === "ignore_while_running" && entry.controller !== undefined)
        return Promise.resolve(abandoned);
      if (concurrency === "latest_wins") entry.controller?.abort();
      const sequence = ++entry.sequence;
      const start = async (): Promise<ServerDrivenResult> => {
        if (signal?.aborted) return abandoned;
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        entry.controller = controller;
        changeRunning(controlId, 1);
        try {
          const result = await execute(controller.signal);
          return controller.signal.aborted ||
            (concurrency === "latest_wins" && entry.sequence !== sequence)
            ? abandoned
            : result;
        } finally {
          signal?.removeEventListener("abort", abort);
          if (entry.controller === controller) delete entry.controller;
          changeRunning(controlId, -1);
        }
      };
      if (concurrency !== "queue") return start();
      const result = (entry.tail ?? Promise.resolve()).then(start, start);
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      entry.tail = tail;
      void tail.then(() => {
        if (entry.tail === tail) delete entry.tail;
      });
      return result;
    },
  };
}

export type FlowRuntimeState = ReturnType<typeof createFlowRuntimeState>;

/** The safe identity of a binding used by a surface that does not receive its input map. */
export type FlowBindingReference = Readonly<{
  bindingId: string;
  flowId: string;
  event: string;
}>;

export type FlowRuntime = Readonly<{
  /**
   * Runs the flow bound to one component event: the server starts it and the page drives it through
   * its continuations. `clickId` is the one identity of the user gesture: supplying the same
   * identity for a repeated request makes the server reach the same run, so a resubmission never
   * commits a second time.
   */
  dispatch: (
    binding: ComponentFlowBinding,
    callerInputs?: Readonly<Record<string, unknown>>,
    clickId?: string,
    subject?: FlowSubjectContext,
  ) => Promise<ServerDrivenResult>;
  /** Starts one exact server binding and drives its normal intents and continuations. */
  dispatchReference: (
    binding: FlowBindingReference,
    callerInputs?: Readonly<Record<string, unknown>>,
    clickId?: string,
    signal?: AbortSignal,
    subject?: FlowSubjectContext,
  ) => Promise<ServerDrivenResult>;
}>;

export function createFlowRuntime(options: FlowRuntimeOptions): FlowRuntime {
  const dispatchReference = async (
    binding: FlowBindingReference,
    callerInputs: Readonly<Record<string, unknown>> = {},
    clickId?: string,
    signal?: AbortSignal,
    subject?: FlowSubjectContext,
  ): Promise<ServerDrivenResult> => {
    const settings = options.bindingSettings(binding.bindingId);
    if (settings === undefined) {
      console.error(`[flow] binding ${binding.bindingId} has no projected settings`);
      return { kind: "refused" };
    }
    const gestureId = clickId ?? crypto.randomUUID();
    return options.state.run(
      binding.bindingId,
      settings.controlId,
      settings.concurrency,
      signal,
      async (runSignal) => {
        const first = await options.client.startBinding(
          { bindingId: binding.bindingId, flowId: binding.flowId },
          callerInputs,
          gestureId,
          runSignal,
          subject,
        );
        return driveServerFlow(
          options.client,
          binding.flowId,
          first,
          options.host,
          runSignal,
          options.committed === undefined
            ? undefined
            : () => options.committed?.(binding.bindingId),
        );
      },
    );
  };
  return Object.freeze({
    dispatchReference,
    dispatch: (binding, callerInputs = {}, clickId, subject) =>
      dispatchReference(
        { bindingId: binding.bindingId, flowId: binding.flow.flowId, event: binding.event },
        callerInputs,
        clickId,
        undefined,
        subject,
      ),
  });
}
