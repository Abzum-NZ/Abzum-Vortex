import type {
  BrowserFlowPlan,
  FlowBindingInput,
  ComponentFlowBinding,
  FlowBindingConcurrency,
  FlowFormula,
  PageDefinition,
} from "@vortex/platform/schema";
import { isRecord, type JsonValue } from "@vortex/platform/schema";
import type { FlowIntentHost } from "./intents";
import type {
  FlowInvokeClient,
  FlowSubjectContext,
  ServerFlowResponse,
} from "./server-flow-client";
import { startFlowEventCycle, type FlowEventCycle } from "./flow-cycle";
import type { TypedFieldValue } from "../controls/projected-data";
import { createExclusiveScopes } from "./exclusive";
import { createFormSettler } from "./settle";

import { createPageValueSlots } from "./page-values";
import { createPageMessages } from "./messages";

type CallerInputs =
  | Readonly<Record<string, unknown>>
  | ((
      signal: AbortSignal,
    ) =>
      | Readonly<Record<string, unknown>>
      | undefined
      | Promise<Readonly<Record<string, unknown>> | undefined>);

/** What one dispatched gesture came to, as the page runner reports it. */
export type FlowDispatchResult =
  /** The binding condition did not hold, so its flow was not started. */
  | Readonly<{ kind: "skipped" }>
  /** The run ended; `descriptor` is its safe result and outputs are as the run released them. */
  | Readonly<{
      kind: "finished";
      runId: string;
      descriptor: Extract<ServerFlowResponse, { kind: "result" }>["descriptor"];
      outputs: Readonly<Record<string, JsonValue>>;
      failure?: Extract<ServerFlowResponse, { kind: "result" }>["failure"];
    }>
  /** The surface is older than the installation: nothing ran and the page must reload. */
  | Readonly<{ kind: "reload"; installationRevision: number }>
  /** Unknown, expired, foreign, tampered or not permitted: the one neutral refusal. */
  | Readonly<{ kind: "refused"; reason?: string }>
  /** A pasted, filled or undone batch stopped before any cell was written: every cell that stopped it. */
  | Extract<ServerFlowResponse, { kind: "cells_refused" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "unknown"; controlId?: string; retry?: () => Promise<FlowDispatchResult> }>
  /** The surface or caller went away before the run finished. */
  | Readonly<{ kind: "abandoned" }>;

/** Stable key ordering makes equivalent submitted answers share one retry identity. */
const canonicalInputs = (inputs: Readonly<Record<string, unknown>>) =>
  JSON.stringify(inputs, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );

export type FlowRuntimeOptions = Readonly<{
  client: FlowInvokeClient;
  /** Every binding's compiled page plan: each gesture runs through it, page and server segments alike. */
  browserBinding: (
    bindingId: string,
  ) =>
    | Readonly<{ plan: BrowserFlowPlan; inputs: Readonly<Record<string, FlowBindingInput>> }>
    | undefined;
  /** The organisation's time zone the page plan resolves dates in; a page with bindings has one. */
  timeZone?: string;
  /** The record the page was rendered for: the form-submit mapping fills a declared `record` input from it. */
  subject?: FlowSubjectContext;
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
  /** Keep submission evidence for the entire gesture, including every server segment. */
  begin?: (bindingId: string, clickId: string) => () => void;
}>;

/** State shared by page and agent dispatches, with subscriptions scoped to a component. */
export function createFlowRuntimeState(
  declarations: NonNullable<PageDefinition["values"]> = {},
  initialFormTypes: Readonly<Record<string, Readonly<Record<string, string>>>> = {},
) {
  let formTypes = initialFormTypes;
  type Job = { controller: AbortController; flush: () => void; hold: () => () => void };
  const entries = new Map<string, { jobs: Set<Job>; tail?: Promise<void> }>();
  const scopes = createExclusiveScopes();
  const settler = createFormSettler();
  const running = new Map<string, number>();
  const cycles = new Map<string, Readonly<{ cycle: FlowEventCycle }>>();
  const listeners = new Map<string, Set<() => void>>();
  const retries = new Map<string, string>();
  const forms = new Map<
    string,
    Readonly<{
      read: (fieldKey: string) => TypedFieldValue | undefined;
      write: (fieldKey: string, value: unknown, cycle: FlowEventCycle) => boolean;
      validate: () => boolean;
    }>
  >();
  /** A form is registered under its placement and, in a dialog, the dialog's own scope, so two copies never collide. */
  const formKey = (formId: string, scope: string) => `${scope}|${formId.toLowerCase()}`;
  /** The form of a scope, else the page's own form of that placement. */
  const formIn = (formId: string, scope: string) =>
    forms.get(formKey(formId, scope)) ?? forms.get(formKey(formId, ""));
  const notify = (controlId: string) => listeners.get(controlId)?.forEach((listener) => listener());
  const pageValues = createPageValueSlots(declarations, (key) => notify(`page:${key}`));
  const messages = createPageMessages((key) => notify(`message:${key}`));
  const changeRunning = (controlId: string, amount: number) => {
    const before = running.get(controlId) ?? 0;
    const after = before + amount;
    if (after === 0) running.delete(controlId);
    else running.set(controlId, after);
    if ((before === 0) !== (after === 0)) notify(controlId);
  };
  const abandoned: FlowDispatchResult = { kind: "abandoned" };
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
      const draft = inputs.draft;
      return isRecord(draft)
        ? JSON.stringify([bindingId, draft.draftId, draft.revision])
        : JSON.stringify([bindingId, subject?.recordId ?? null, canonicalInputs(inputs)]);
    },
    retryId: (key: string, proposed: string) => retries.get(key) ?? proposed,
    rememberResult: (key: string, runId: string, result: FlowDispatchResult) => {
      if (result.kind === "unknown") retries.set(key, runId);
      else if (result.kind !== "abandoned") retries.delete(key);
    },
    pageValues,
    messages,
    setFormTypes: (next: typeof formTypes) => {
      formTypes = next;
    },
    formType: (formId: string, fieldKey: string) =>
      Object.entries(formTypes).find(([id]) => id.toLowerCase() === formId.toLowerCase())?.[1][
        fieldKey
      ],
    formChanged: (formId: string, fieldKey: string) =>
      notify(`form:${formId.toLowerCase()}:${fieldKey}`),
    isRunning: (controlId: string) => (running.get(controlId) ?? 0) > 0,
    registerForm: (
      formId: string,
      read: (fieldKey: string) => TypedFieldValue | undefined,
      write: (fieldKey: string, value: unknown, cycle: FlowEventCycle) => boolean,
      validate: () => boolean,
      scope = "",
    ) => {
      const key = formKey(formId, scope);
      if (forms.has(key)) throw new Error(`Form '${formId}' is registered more than once`);
      const form = { read, write, validate };
      forms.set(key, form);
      for (const fieldKey of Object.keys(formTypes[formId] ?? {}))
        notify(`form:${formId.toLowerCase()}:${fieldKey}`);
      return () => {
        if (forms.get(key) === form) {
          forms.delete(key);
          for (const fieldKey of Object.keys(formTypes[formId] ?? {}))
            notify(`form:${formId.toLowerCase()}:${fieldKey}`);
        }
      };
    },
    readFormValue: (formId: string, fieldKey: string, scope = "") =>
      formIn(formId, scope)?.read(fieldKey),
    writeFormValue: (
      formId: string,
      fieldKey: string,
      value: unknown,
      cycle: FlowEventCycle,
      scope = "",
    ) => formIn(formId, scope)?.write(fieldKey, value, cycle) ?? false,
    validateForm: (formId: string, scope = "") => formIn(formId, scope)?.validate() ?? false,
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
    /** Stops the timeout clocks of a binding's running jobs while a step waits on the person; the returned call starts them again. */
    holdTimeouts: (bindingId: string) => {
      const releases = [...(entries.get(bindingId)?.jobs ?? [])].map((job) => job.hold());
      return () => {
        for (const release of releases) release();
      };
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
      execute: (signal: AbortSignal) => Promise<FlowDispatchResult>,
    ): Promise<FlowDispatchResult> => {
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
      let hold = (): (() => void) => () => {};
      const job: Job = {
        controller,
        flush: () => {
          flush();
        },
        hold: () => hold(),
      };
      const settlesForm =
        (event === "form_submit" ||
          event === "guided_step_changed" ||
          (event === "action" && exclusive === "form")) &&
        formId;
      const pendingChanges = settlesForm ? settler.pending(settlesForm) : [];
      const scope = {
        exclusive,
        name: settings.flowName,
        ...(formId ? { formId } : {}),
        allowed: new Set(pendingChanges.map((change) => change.job)),
      };
      const ticket =
        initialConflict !== undefined && concurrency === "queue"
          ? scopes.enqueue(scope, job)
          : undefined;
      let release: (() => void) | undefined;
      if (exclusive !== "none" && (exclusive !== "form" || formId !== undefined)) {
        if (scopes.conflict(scope, job) === undefined) release = scopes.acquire(scope);
      }
      entry.jobs.add(job);
      changeRunning(controlId, 1);
      let timedOut = false;
      let timeLeft = timeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let armedAt = 0;
      let holds = 0;
      let finished = false;
      const arm = () => {
        if (timeLeft === null || finished) return;
        armedAt = Date.now();
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeLeft);
      };
      arm();
      // The time a step spends waiting on the person is not the flow's own: the clock stands still.
      hold = () => {
        if (holds++ === 0 && timer !== undefined && timeLeft !== null) {
          clearTimeout(timer);
          timer = undefined;
          timeLeft = Math.max(0, timeLeft - (Date.now() - armedAt));
        }
        let released = false;
        return () => {
          if (released) return;
          released = true;
          if (--holds === 0) arm();
        };
      };
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
      const start = async (): Promise<FlowDispatchResult> => {
        if (controller.signal.aborted) return abandoned;
        await ready;
        if (controller.signal.aborted) return abandoned;
        if (exclusive === "form" && formId === undefined)
          return { kind: "refused", reason: "This action has no form to lock." };
        if (release === undefined) {
          let held = scopes.conflict(scope, job);
          while (held !== undefined || (ticket !== undefined && !ticket.turn())) {
            if (concurrency !== "queue")
              return {
                kind: "refused",
                reason: `${held?.name ?? settings.flowName} is still running.`,
              };
            await scopes.wait(controller.signal);
            if (controller.signal.aborted) return abandoned;
            held = scopes.conflict(scope, job);
          }
          release = scopes.acquire(scope);
          ticket?.remove();
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
      const stopped = new Promise<FlowDispatchResult>((resolve) => {
        stopWaiting = () => resolve(abandoned);
        if (controller.signal.aborted) stopWaiting();
        else controller.signal.addEventListener("abort", stopWaiting, { once: true });
      });
      const result = Promise.race([scheduled, stopped])
        .then((outcome) => (timedOut ? ({ kind: "unknown" } as const) : outcome))
        .finally(() => {
          signal?.removeEventListener("abort", abort);
          if (stopWaiting !== undefined)
            controller.signal.removeEventListener("abort", stopWaiting);
          finished = true;
          if (timer !== undefined) clearTimeout(timer);
          ticket?.remove();
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

/**
 * The runtime state as a dialog's form sees it: its form registers, reads, writes and validates in
 * the dialog's own scope (the form's placement and the dialog's run), and everything else is the
 * page's. The same form shown inline and in a dialog never collide.
 */
export const scopeFlowRuntimeForms = (
  state: FlowRuntimeState,
  scope: string,
): FlowRuntimeState => ({
  ...state,
  registerForm: (formId, read, write, validate) =>
    state.registerForm(formId, read, write, validate, scope),
  readFormValue: (formId, fieldKey) => state.readFormValue(formId, fieldKey, scope),
  writeFormValue: (formId, fieldKey, value, cycle) =>
    state.writeFormValue(formId, fieldKey, value, cycle, scope),
  validateForm: (formId) => state.validateForm(formId, scope),
});

/** The safe identity of a binding used by a surface that does not receive its input map. */
export type PlacementFlowBinding = Readonly<{
  /** Derived action bindings are started only by their message, not by the control's event. */
  messageAction?: Readonly<{ authoredBindingId: string; sourceFlowId: string; taskId: string }>;
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
  ) => Promise<FlowDispatchResult>;
  /** Starts one exact server binding and drives its normal intents and continuations. */
  dispatchReference: (
    binding: FlowBindingReference,
    callerInputs: CallerInputs | undefined,
    clickId: string,
    signal?: AbortSignal,
    subject?: FlowSubjectContext,
    sourceTablePlacementId?: string,
    cycle?: FlowEventCycle,
  ) => Promise<FlowDispatchResult>;
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
  ): Promise<FlowDispatchResult> => {
    const settings = options.bindingSettings(binding.bindingId);
    if (settings === undefined) {
      console.error(`[flow] binding ${binding.bindingId} has no projected settings`);
      return { kind: "refused" };
    }
    let retry:
      { key: string; runId: string; inputs: Readonly<Record<string, unknown>> } | undefined;
    let end: (() => void) | undefined;
    const execute = (nextSignal?: AbortSignal, resume?: () => Promise<FlowDispatchResult>) =>
      options.state.run(binding.bindingId, settings, nextSignal, async (runSignal) => {
        if (retry === undefined) {
          const inputs =
            typeof callerInputs === "function"
              ? await callerInputs(runSignal)
              : (callerInputs ?? {});
          if (runSignal.aborted) return { kind: "abandoned" };
          if (inputs === undefined) return { kind: "skipped" };
          const key = options.state.retryKey(binding.bindingId, subject, inputs);
          retry = { key, runId: options.state.retryId(key, clickId), inputs };
          end = options.begin?.(binding.bindingId, retry.runId);
        }
        const attempt = retry;
        const releaseCycle = options.state.trackCycle(
          attempt.runId,
          cycle ?? startFlowEventCycle(binding.flowId, settings.controlId),
        );
        try {
          if (resume !== undefined) return await resume();
          const { runFlowBinding } = await import("./flow-runtime-driver");
          return await runFlowBinding(
            options,
            binding,
            attempt.inputs,
            attempt.runId,
            runSignal,
            subject,
            sourceTablePlacementId,
            settings,
          );
        } finally {
          releaseCycle();
        }
      });
    const keepRetry = (result: FlowDispatchResult): FlowDispatchResult => {
      if (retry !== undefined) options.state.rememberResult(retry.key, retry.runId, result);
      if (result.kind !== "unknown") {
        end?.();
        return result;
      }
      return {
        ...result,
        controlId: settings.controlId,
        retry: async () => keepRetry(await execute(undefined, result.retry)),
      };
    };
    try {
      return keepRetry(await execute(signal));
    } catch (error) {
      end?.();
      throw error;
    }
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
