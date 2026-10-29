import {
  safeFlowResultDescriptors,
  type BrowserFlowPlan,
  type FlowBindingInput,
  type ComponentFlowBinding,
  type FlowBindingConcurrency,
  type FlowFormula,
} from "@vortex/platform/schema";
import type { FlowIntentHost } from "./intents";
import type { ServerDrivenResult } from "./server-driven-run";
import type { FlowInvokeClient, FlowSubjectContext } from "./server-flow-client";
import { startFlowEventCycle, type FlowEventCycle } from "./flow-cycle";
import type { TypedFieldValue } from "../controls/projected-data";

export type FlowRuntimeOptions = Readonly<{
  client: FlowInvokeClient;
  browserBinding?: (
    bindingId: string,
  ) =>
    | Readonly<{ plan: BrowserFlowPlan; inputs: Readonly<Record<string, FlowBindingInput>> }>
    | undefined;
  timeZone?: string;
  host: FlowIntentHost;
  state: FlowRuntimeState;
  bindingSettings: (bindingId: string) =>
    | Readonly<{
        controlId: string;
        concurrency: FlowBindingConcurrency;
        condition: FlowFormula | null;
      }>
    | undefined;
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
  const cycles = new Map<string, Readonly<{ cycle: FlowEventCycle }>>();
  const listeners = new Map<string, Set<() => void>>();
  const forms = new Map<string, (fieldKey: string) => TypedFieldValue | undefined>();
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
    registerForm: (formId: string, read: (fieldKey: string) => TypedFieldValue | undefined) => {
      const key = formId.toLowerCase();
      if (forms.has(key)) throw new Error(`Form '${formId}' is registered more than once`);
      forms.set(key, read);
      return () => {
        if (forms.get(key) === read) forms.delete(key);
      };
    },
    readFormValue: (formId: string, fieldKey: string) =>
      forms.get(formId.toLowerCase())?.(fieldKey),
    cycleFor: (gestureId: string) => cycles.get(gestureId)?.cycle,
    trackCycle: (gestureId: string, cycle: FlowEventCycle) => {
      const held = { cycle };
      cycles.set(gestureId, held);
      return () => {
        if (cycles.get(gestureId) === held) cycles.delete(gestureId);
      };
    },
    cancel: (bindingId: string) => {
      const entry = entries.get(bindingId);
      if (entry === undefined) return;
      entry.sequence += 1;
      entry.controller?.abort();
    },
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
  /** Loads the page runner after visible data has been served. */
  prefetch: () => Promise<void>;
  /**
   * Runs the flow bound to one component event: the server starts it and the page drives it through
   * its continuations. `clickId` is the one identity of the user gesture: supplying the same
   * identity for a repeated request makes the server reach the same run, so a resubmission never
   * commits a second time.
   */
  dispatch: (
    binding: ComponentFlowBinding,
    callerInputs: Readonly<Record<string, unknown>> | undefined,
    clickId: string,
    subject?: FlowSubjectContext,
    cycle?: FlowEventCycle,
  ) => Promise<ServerDrivenResult>;
  /** Starts one exact server binding and drives its normal intents and continuations. */
  dispatchReference: (
    binding: FlowBindingReference,
    callerInputs: Readonly<Record<string, unknown>> | undefined,
    clickId: string,
    signal?: AbortSignal,
    subject?: FlowSubjectContext,
    cycle?: FlowEventCycle,
  ) => Promise<ServerDrivenResult>;
}>;

export function createFlowRuntime(options: FlowRuntimeOptions): FlowRuntime {
  const dispatchReference = async (
    binding: FlowBindingReference,
    callerInputs: Readonly<Record<string, unknown>> | undefined,
    clickId: string,
    signal?: AbortSignal,
    subject?: FlowSubjectContext,
    cycle?: FlowEventCycle,
  ): Promise<ServerDrivenResult> => {
    const settings = options.bindingSettings(binding.bindingId);
    if (settings === undefined) {
      console.error(`[flow] binding ${binding.bindingId} has no projected settings`);
      return { kind: "refused" };
    }
    return options.state.run(
      binding.bindingId,
      settings.controlId,
      settings.concurrency,
      signal,
      async (runSignal) => {
        const releaseCycle = options.state.trackCycle(
          clickId,
          cycle ?? startFlowEventCycle(binding.flowId, settings.controlId),
        );
        try {
          const browser = options.browserBinding?.(binding.bindingId);
          if (browser !== undefined && options.timeZone !== undefined) {
            const { startBrowserFlow } = await import("./browser-flow-runner");
            const result = await startBrowserFlow({
              plan: browser.plan,
              bindings: browser.inputs,
              caller: callerInputs ?? {},
              runId: clickId,
              timeZone: options.timeZone,
              host: options.host,
              readFormValue: options.state.readFormValue,
              condition: settings.condition,
              signal: runSignal,
            });
            if (result.kind === "abandoned") return { kind: "abandoned", unanswered: true };
            if (result.kind === "skipped") return { kind: "skipped" };
            if (result.kind === "completed")
              return {
                kind: "finished",
                runId: clickId,
                descriptor: safeFlowResultDescriptors.completed,
                outputs: result.outputs,
              };
            if (result.kind === "failed")
              return {
                kind: "finished",
                runId: clickId,
                descriptor: safeFlowResultDescriptors[result.failure.outcome],
                outputs: {},
                failure: {
                  code: result.failure.code,
                  ...(result.failure.taskId === undefined ? {} : { taskId: result.failure.taskId }),
                  ...(result.failure.diagnostic === undefined
                    ? {}
                    : { diagnostic: result.failure.diagnostic }),
                },
              };
          }
          const [first, { driveServerFlow }] = await Promise.all([
            options.client.startBinding(
              { bindingId: binding.bindingId, flowId: binding.flowId },
              callerInputs ?? {},
              clickId,
              runSignal,
              subject,
            ),
            import("./server-driven-run"),
          ]);
          return await driveServerFlow(
            options.client,
            binding.flowId,
            first,
            options.host,
            runSignal,
            options.committed === undefined
              ? undefined
              : () => options.committed?.(binding.bindingId),
          );
        } finally {
          releaseCycle();
        }
      },
    );
  };
  return Object.freeze({
    prefetch: async () => {
      await import("./browser-flow-runner");
    },
    dispatchReference,
    dispatch: (binding, callerInputs = {}, clickId, subject, cycle) =>
      dispatchReference(
        { bindingId: binding.bindingId, flowId: binding.flow.flowId, event: binding.event },
        callerInputs,
        clickId,
        undefined,
        subject,
        cycle,
      ),
  });
}
