import type {
  BrowserFlowPlan,
  FlowBindingInput,
  ComponentFlowBinding,
  FlowBindingConcurrency,
  FlowFormula,
} from "@vortex/platform/schema";
import {
  guidedFormConfirmationKey,
  guidedFormConfirmationReference,
  isRecord,
} from "@vortex/platform/schema";
import type { FlowIntentHost } from "./intents";
import type { ServerDrivenResult } from "./server-driven-run";
import type { FlowInvokeClient, FlowSubjectContext } from "./server-flow-client";
import { startFlowEventCycle, type FlowEventCycle } from "./flow-cycle";
import type { TypedFieldValue } from "../controls/projected-data";
import { createExclusiveScopes } from "./exclusive";
import { createFormSettler } from "./settle";

type CallerInputs =
  | Readonly<Record<string, unknown>>
  | ((
      signal: AbortSignal,
    ) =>
      | Readonly<Record<string, unknown>>
      | undefined
      | Promise<Readonly<Record<string, unknown>> | undefined>);

/** Stable key ordering makes equivalent submitted answers share one retry identity. */
const canonicalInputs = (inputs: Readonly<Record<string, unknown>>) =>
  JSON.stringify(inputs, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );

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
        debounceMs: number;
        exclusive: ComponentFlowBinding["settings"]["exclusive"];
        timeoutMs: number | null;
        event: string;
        flowName: string;
        controlName: string;
        formId?: string;
      }>
    | undefined;
  /**
   * Told, with the binding's identity, when a server run of that binding committed and before its
   * closing messages are shown, so the page can re-read the placements the binding writes.
   */
  committed?: (bindingId: string) => void;
  /** Keep submission evidence for the entire gesture, including every server segment. */
  begin?: (bindingId: string, clickId: string) => () => void;
}>;

/** State shared by page and agent dispatches, with subscriptions scoped to a component. */
export function createFlowRuntimeState() {
  type Job = { controller: AbortController; flush: () => void };
  const entries = new Map<string, { jobs: Set<Job>; tail?: Promise<void> }>();
  const scopes = createExclusiveScopes();
  const settler = createFormSettler();
  const running = new Map<string, number>();
  const cycles = new Map<string, Readonly<{ cycle: FlowEventCycle }>>();
  const listeners = new Map<string, Set<() => void>>();
  const retries = new Map<string, string>();
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
    dispose: () => {
      for (const entry of entries.values()) for (const job of entry.jobs) job.controller.abort();
      retries.clear();
    },
    retryKey: (
      bindingId: string,
      subject: FlowSubjectContext | undefined,
      inputs: Readonly<Record<string, unknown>>,
    ) => {
      const values = inputs.values;
      const guided = guidedFormConfirmationReference(
        isRecord(values) ? values[guidedFormConfirmationKey] : undefined,
      );
      return guided === undefined
        ? JSON.stringify([bindingId, subject?.recordId ?? null, canonicalInputs(inputs)])
        : JSON.stringify([bindingId, guided.draftId, guided.revision]);
    },
    retryId: (key: string, proposed: string) => retries.get(key) ?? proposed,
    rememberResult: (key: string, runId: string, result: ServerDrivenResult) => {
      if (result.kind === "unavailable" || (result.kind === "abandoned" && !result.unanswered))
        retries.set(key, runId);
      else if (result.kind !== "abandoned") retries.delete(key);
    },
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
      for (const job of entry.jobs) job.controller.abort();
    },
    flush: (bindingId: string) => {
      for (const job of entries.get(bindingId)?.jobs ?? []) job.flush();
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
      settings: NonNullable<ReturnType<FlowRuntimeOptions["bindingSettings"]>>,
      signal: AbortSignal | undefined,
      execute: (signal: AbortSignal) => Promise<ServerDrivenResult>,
    ): Promise<ServerDrivenResult> => {
      if (signal?.aborted) return Promise.resolve(abandoned);
      const { controlId, concurrency, debounceMs, exclusive, timeoutMs, event, formId } = settings;
      const initialConflict = scopes.conflict({
        exclusive,
        name: settings.flowName,
        ...(formId ? { formId } : {}),
      });
      if (initialConflict !== undefined && concurrency !== "queue")
        return Promise.resolve({
          kind: "refused",
          reason: `${initialConflict.name} is still running.`,
        });
      const entry = entries.get(bindingId) ?? { jobs: new Set<Job>() };
      entries.set(bindingId, entry);
      if (concurrency === "ignore_while_running" && entry.jobs.size > 0)
        return Promise.resolve(abandoned);
      if (concurrency === "latest_wins") for (const job of entry.jobs) job.controller.abort();
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      let flush = () => {};
      const job: Job = {
        controller,
        flush: () => {
          flush();
        },
      };
      const settlesForm =
        (event === "form_submit" || (event === "action" && exclusive === "form")) && formId;
      const pendingChanges = settlesForm ? settler.pending(settlesForm) : [];
      const scope = {
        exclusive,
        name: settings.flowName,
        ...(formId ? { formId } : {}),
        allowed: new Set(pendingChanges.map((change) => change.job)),
      };
      let release: (() => void) | undefined;
      if (exclusive !== "none" && (exclusive !== "form" || formId !== undefined)) {
        if (scopes.conflict(scope, job) === undefined) release = scopes.acquire(scope);
      }
      entry.jobs.add(job);
      changeRunning(controlId, 1);
      let timedOut = false;
      const timer =
        timeoutMs === null
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, timeoutMs);
      const ready =
        debounceMs === 0
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              const done = () => {
                clearTimeout(timer);
                controller.signal.removeEventListener("abort", done);
                flush = () => {};
                resolve();
              };
              const timer = setTimeout(done, debounceMs);
              flush = done;
              controller.signal.addEventListener("abort", done, { once: true });
            });
      const start = async (): Promise<ServerDrivenResult> => {
        if (controller.signal.aborted) return abandoned;
        await ready;
        if (controller.signal.aborted) return abandoned;
        if (exclusive === "form" && formId === undefined)
          return { kind: "refused", reason: "This action has no form to lock." };
        if (release === undefined) {
          let held = scopes.conflict(scope, job);
          while (held !== undefined) {
            if (concurrency !== "queue")
              return { kind: "refused", reason: `${held.name} is still running.` };
            await scopes.wait(controller.signal);
            if (controller.signal.aborted) return abandoned;
            held = scopes.conflict(scope, job);
          }
          release = scopes.acquire(scope);
        }
        if (settlesForm) {
          const field = await settler.settle(pendingChanges, controller.signal);
          if (controller.signal.aborted) return abandoned;
          if (field !== undefined) return { kind: "refused", reason: `Still checking ${field}.` };
        }
        return Promise.race([execute(controller.signal), stopped]);
      };
      const scheduled =
        concurrency === "queue"
          ? (entry.tail ?? Promise.resolve()).then(start, start)
          : Promise.resolve().then(start);
      let stopWaiting: (() => void) | undefined;
      const stopped = new Promise<ServerDrivenResult>((resolve) => {
        stopWaiting = () => resolve(abandoned);
        if (controller.signal.aborted) stopWaiting();
        else controller.signal.addEventListener("abort", stopWaiting, { once: true });
      });
      const result = Promise.race([scheduled, stopped])
        .then((outcome) =>
          timedOut ? { kind: "abandoned" as const, unanswered: false, timedOut: true } : outcome,
        )
        .finally(() => {
          signal?.removeEventListener("abort", abort);
          if (stopWaiting !== undefined)
            controller.signal.removeEventListener("abort", stopWaiting);
          if (timer !== undefined) clearTimeout(timer);
          release?.();
          entry.jobs.delete(job);
          changeRunning(controlId, -1);
        });
      if (formId && (event === "field_changed" || event === "options_requested"))
        settler.track({
          formId,
          job,
          fieldName: settings.controlName,
          finished: result,
          flush: job.flush,
          cancel: abort,
        });
      if (concurrency !== "queue") return result;
      // Keep the queue ordered even if a waiting caller has already abandoned its wait.
      const tail = scheduled.then(
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
export type PlacementFlowBinding = Readonly<{
  controlId: ComponentFlowBinding["controlId"];
  controlName: string;
  flowName: string;
  formId?: string;
  settings: ComponentFlowBinding["settings"];
  browser?: Readonly<{ plan: BrowserFlowPlan; inputs: Readonly<Record<string, FlowBindingInput>> }>;
  bindingId: string;
  eventId: string;
  flowId: string;
  event: string;
  entrySegments: readonly Readonly<{ segmentId: string; fingerprint: string }>[];
  callerInputs: readonly string[];
  savesFormValues: boolean;
  recordTypeId?: string;
  selectedReadInputs?: readonly Readonly<{ callerInputName: string; recordTypeId: string }>[];
}>;

/** The safe identity a tool receives for its projected binding. */
export type FlowBindingReference = Pick<
  PlacementFlowBinding,
  "bindingId" | "flowId" | "event" | "entrySegments"
>;

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
    binding: PlacementFlowBinding,
    callerInputs: CallerInputs | undefined,
    clickId: string,
    subject?: FlowSubjectContext,
    sourceTablePlacementId?: string,
    cycle?: FlowEventCycle,
  ) => Promise<ServerDrivenResult>;
  /** Starts one exact server binding and drives its normal intents and continuations. */
  dispatchReference: (
    binding: FlowBindingReference,
    callerInputs: CallerInputs | undefined,
    clickId: string,
    signal?: AbortSignal,
    subject?: FlowSubjectContext,
    sourceTablePlacementId?: string,
    cycle?: FlowEventCycle,
  ) => Promise<ServerDrivenResult>;
}>;

export function createFlowRuntime(options: FlowRuntimeOptions): FlowRuntime {
  const dispatchReference = async (
    binding: FlowBindingReference,
    callerInputs: CallerInputs | undefined,
    clickId: string,
    signal?: AbortSignal,
    subject?: FlowSubjectContext,
    sourceTablePlacementId?: string,
    cycle?: FlowEventCycle,
  ): Promise<ServerDrivenResult> => {
    const settings = options.bindingSettings(binding.bindingId);
    if (settings === undefined) {
      console.error(`[flow] binding ${binding.bindingId} has no projected settings`);
      return { kind: "refused" };
    }
    let retry: { key: string; runId: string } | undefined;
    let releaseRun = () => {};
    return options.state
      .run(binding.bindingId, settings, signal, async (runSignal) => {
        const inputs =
          typeof callerInputs === "function" ? await callerInputs(runSignal) : (callerInputs ?? {});
        if (runSignal.aborted) return { kind: "abandoned", unanswered: true };
        if (inputs === undefined) return { kind: "skipped" };
        const key = options.state.retryKey(binding.bindingId, subject, inputs);
        const runId = options.state.retryId(key, clickId);
        retry = { key, runId };
        const end = options.begin?.(binding.bindingId, runId);
        const releaseCycle = options.state.trackCycle(
          runId,
          cycle ?? startFlowEventCycle(binding.flowId, settings.controlId),
        );
        releaseRun = () => {
          releaseCycle();
          end?.();
          releaseRun = () => {};
        };
        try {
          const { runFlowBinding } = await import("./flow-runtime-driver");
          return await runFlowBinding(
            options,
            binding,
            inputs,
            runId,
            runSignal,
            subject,
            sourceTablePlacementId,
            settings,
          );
        } finally {
          releaseRun();
        }
      })
      .then((result) => {
        if (retry !== undefined) options.state.rememberResult(retry.key, retry.runId, result);
        return result;
      })
      .finally(() => releaseRun());
  };
  return Object.freeze({
    prefetch: async () => {
      await Promise.all([import("./flow-runtime-driver"), import("./browser-flow-runner")]);
    },
    dispatchReference,
    dispatch: (binding, callerInputs = {}, clickId, subject, sourceTablePlacementId, cycle) =>
      dispatchReference(
        binding,
        callerInputs,
        clickId,
        undefined,
        subject,
        sourceTablePlacementId,
        cycle,
      ),
  });
}
