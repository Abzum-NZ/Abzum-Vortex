import {
  browserFlowMemberTypeResolver,
  evaluateFlowFormula,
  pageFlowScope,
  pageFlowGuardMatches,
  pageFlowSegmentSeed,
  addPageFlowOutputs,
  pageFlowFinalOutputs,
  resolvePageFlowInputs,
  pageFlowFormValue,
  flowNeedsRunStart,
  type FlowBindingInput,
  type BrowserFlowPlan,
  type FlowFailure,
  type FlowFormula,
  type FlowFormReferenceResolver,
  type FlowProgram,
  type FlowRunStart,
  type FlowRunState,
  type FlowRuntimeValues,
  type JsonValue,
} from "@vortex/platform/schema";
import { drivePageFlowSegment } from "./page-flow-segment";
import { pageFlowClock } from "./page-flow-clock";
import { isSurfaceCancellation, type FlowIntentHost } from "./intents";
import type { FlowBindingReference } from "./flow-runtime";
import type { FlowInvokeClient, FlowSubjectContext } from "./server-flow-client";
import type { ServerDrivenResult } from "./server-driven-run";

export type BrowserFlowResult =
  | Readonly<{
      kind: "completed";
      outputs: Readonly<Record<string, JsonValue>>;
      committed?: boolean;
    }>
  | Readonly<{ kind: "failed"; failure: FlowFailure }>
  | Readonly<{ kind: "abandoned" }>
  | Readonly<{ kind: "skipped" }>
  | Readonly<{ kind: "server_result"; result: ServerDrivenResult }>
  | Readonly<{ kind: "not_page_only" }>;

/** Runs each compiled page segment locally and each protected segment through its gate. */
export async function runBrowserFlow(
  input: Readonly<{
    plan: BrowserFlowPlan;
    start: FlowRunStart;
    host: FlowIntentHost;
    readPageValues: () => FlowRuntimeValues;
    resolveForm?: FlowFormReferenceResolver;
    condition?: FlowFormula | null;
    signal?: AbortSignal;
    server?: Readonly<{
      client: FlowInvokeClient;
      binding: FlowBindingReference;
      caller: Readonly<Record<string, unknown>>;
      pageInputs: ReadonlySet<string>;
      subject?: FlowSubjectContext;
      sourceTablePlacementId?: string;
      committed?: () => void;
    }>;
  }>,
): Promise<BrowserFlowResult> {
  const { plan, start, host, resolveForm, signal, condition, server } = input;
  const servers = plan.segments.filter((segment) => segment.kind === "server");
  const isCompletion = (segment: (typeof servers)[number]) =>
    Object.keys(segment.finalOutputTypes).length > 0;
  if (servers.length > 0 && server === undefined) return { kind: "not_page_only" };
  const members = browserFlowMemberTypeResolver(plan);
  const declaredTasks = plan.segments.flatMap((segment) =>
    segment.kind === "page" ? segment.tasks : [],
  );
  const program = (tasks: FlowProgram["tasks"]): FlowProgram => ({
    id: plan.flowId,
    execution: "interactive",
    inputs: plan.inputs,
    variables: plan.variables,
    outputs: {},
    triggers: [],
    tasks,
    errors: [],
    finally: [],
    declaredTasks,
  });
  let state: FlowRunState | undefined;
  let carriedValues: string | undefined;
  let completion: Readonly<Record<string, unknown>> = {};
  let committed = false;
  let failure:
    | { kind: "page"; value: FlowFailure }
    | { kind: "server"; value: ServerDrivenResult }
    | undefined;
  const page = async (tasks: FlowProgram["tasks"]) => {
    const result = await drivePageFlowSegment({
      program: program(tasks),
      start: { ...start, pageValues: input.readPageValues() },
      ...(state === undefined ? {} : { previous: state }),
      resolveMember: members,
      ...(resolveForm === undefined ? {} : { resolveForm }),
      host,
      readPageValues: input.readPageValues,
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.kind === "finished") state = result.state;
    return result;
  };
  const terminal = (result: ServerDrivenResult): BrowserFlowResult => ({
    kind: "server_result",
    result,
  });
  try {
    const initial = await page([]);
    if (initial.kind === "abandoned") return { kind: "abandoned" };
    if (initial.kind === "unavailable")
      return { kind: "failed", failure: { outcome: "failed", code: "flow_unavailable" } };
    if (initial.result.status === "failed")
      return { kind: "failed", failure: initial.result.failure };
    if (condition != null) {
      const value = evaluateFlowFormula(
        condition,
        pageFlowScope(initial.state, program([]), members, resolveForm),
      );
      if (value?.type !== "yes_no" || typeof value.value !== "boolean")
        throw new Error("FLOW_BINDING_CONDITION_INVALID");
      if (!value.value) return { kind: "skipped" };
    }
    if (flowNeedsRunStart(plan.segments)) {
      const opened = await server!.client.openRun(
        server!.binding,
        start.runId,
        signal,
        server!.sourceTablePlacementId,
      );
      if (opened.kind === "run_opened") carriedValues = opened.carriedValues;
      else if (
        opened.kind === "reload" ||
        opened.kind === "refused" ||
        opened.kind === "unavailable"
      )
        return terminal(opened);
      else throw new Error("FLOW_PAGE_RUN_START_INVALID");
    }
    type Part = (typeof plan.segments)[number];
    const run = async (
      segment: Part,
    ): Promise<
      | { kind: "done"; stopped?: string }
      | { kind: "failure"; value: NonNullable<typeof failure> }
      | { kind: "terminal"; value: BrowserFlowResult }
    > => {
      if (state === undefined) throw new Error("FLOW_PAGE_STATE_UNAVAILABLE");
      if (
        !pageFlowGuardMatches(
          segment.guard,
          { ...state, pageValues: input.readPageValues() },
          program([]),
          members,
          resolveForm,
        )
      )
        return { kind: "done" };
      if (segment.kind === "page") {
        const result = await page(segment.tasks);
        if (result.kind === "abandoned") return { kind: "terminal", value: { kind: "abandoned" } };
        if (result.kind === "unavailable")
          return {
            kind: "failure",
            value: { kind: "page", value: { outcome: "failed", code: "flow_unavailable" } },
          };
        if (result.result.status === "failed")
          return { kind: "failure", value: { kind: "page", value: result.result.failure } };
        return {
          kind: "done",
          ...(result.result.stopped === undefined ? {} : { stopped: result.result.stopped }),
        };
      }
      const seed = pageFlowSegmentSeed(
        state,
        segment.inputs,
        server!.pageInputs,
        segment.carriedInputKeys,
        resolveForm,
      );
      const phase =
        segment.section === "tasks"
          ? undefined
          : failure?.kind === "page"
            ? ("page_failure" as const)
            : failure?.kind === "server"
              ? undefined
              : ("success" as const);
      const result = await server!.client.startBinding(
        server!.binding,
        server!.caller,
        start.runId,
        signal,
        server!.subject,
        server!.sourceTablePlacementId,
        carriedValues,
        {
          seed,
          iteration: "0",
          segment: { segmentId: segment.id, fingerprint: segment.fingerprint },
          ...(phase === undefined ? {} : { phase }),
        },
      );
      if (signal?.aborted) return { kind: "terminal", value: { kind: "abandoned" } };
      if (result.kind === "reload" || result.kind === "refused" || result.kind === "unavailable")
        return { kind: "terminal", value: terminal(result) };
      if (result.kind !== "result" || result.intents.length !== 0)
        throw new Error("FLOW_PAGE_SEGMENT_RESPONSE_INVALID");
      carriedValues = result.carriedValues;
      if (result.descriptor.commit === "confirmed" || result.descriptor.commit === "partial") {
        committed = true;
        server!.committed?.();
        if (result.warnings.length > 0)
          await host.showMessage(
            {
              title: "Saved, with a warning",
              target: "dialog",
              text: result.warnings.map((warning) => warning.message).join(" "),
              severity: "warning",
            },
            signal,
          );
      }
      if (result.failure !== undefined)
        return {
          kind: "failure",
          value: {
            kind: "server",
            value: {
              kind: "finished",
              runId: result.runId,
              descriptor: result.descriptor,
              outputs: {},
              failure: result.failure,
            },
          },
        };
      if (isCompletion(segment)) completion = result.outputs;
      else state = addPageFlowOutputs(state, segment.outputs, result.outputs);
      return { kind: "done", ...(result.stopped === undefined ? {} : { stopped: result.stopped }) };
    };
    for (const segment of plan.segments.filter((part) => part.section === "tasks")) {
      const result = await run(segment);
      if (result.kind === "terminal") return result.value;
      if (result.kind === "failure") {
        failure = result.value;
        break;
      }
      if (result.stopped !== undefined) break;
    }
    if (failure !== undefined) {
      for (const segment of plan.segments.filter((part) => part.section === "errors")) {
        const result = await run(segment);
        if (result.kind === "terminal") return result.value;
        if (result.kind === "failure" || result.stopped !== undefined) break;
      }
    }
    for (const segment of plan.segments.filter(
      (part) => part.section === "finally" && !(part.kind === "server" && isCompletion(part)),
    )) {
      const result = await run(segment);
      if (result.kind === "terminal") return result.value;
      if (result.kind === "failure") {
        failure ??= result.value;
        break;
      }
      if (result.stopped !== undefined) break;
    }
    if (failure?.kind === "server") return terminal(failure.value);
    if (failure?.kind === "page") return { kind: "failed", failure: failure.value };
    const final = servers.find(isCompletion);
    if (final !== undefined) {
      const result = await run(final);
      if (result.kind === "terminal") return result.value;
      if (result.kind === "failure")
        return result.value.kind === "server"
          ? terminal(result.value.value)
          : { kind: "failed", failure: result.value.value };
    }
    if (state === undefined) throw new Error("FLOW_PAGE_STATE_UNAVAILABLE");
    return {
      kind: "completed",
      outputs: pageFlowFinalOutputs(
        { ...state, pageValues: input.readPageValues() },
        program([]),
        plan,
        completion,
        members,
        resolveForm,
      ),
      ...(committed ? { committed: true } : {}),
    };
  } catch (error) {
    if (signal?.aborted || isSurfaceCancellation(error)) return { kind: "abandoned" };
    console.error("[flow] page run failed", error);
    return { kind: "failed", failure: { outcome: "failed", code: "flow_unavailable" } };
  }
}

/** Resolves the permitted binding inputs against one organisation-local instant. */
export async function startBrowserFlow(
  input: Readonly<{
    plan: BrowserFlowPlan;
    bindings: Readonly<Record<string, FlowBindingInput>>;
    caller: Readonly<Record<string, unknown>>;
    runId: string;
    timeZone: string;
    host: FlowIntentHost;
    readFormValue: (formId: string, fieldKey: string) => unknown;
    readPageValues: () => FlowRuntimeValues;
    condition?: FlowFormula | null;
    signal?: AbortSignal;
    server?: Readonly<{
      client: FlowInvokeClient;
      binding: FlowBindingReference;
      subject?: FlowSubjectContext;
      sourceTablePlacementId?: string;
      committed?: () => void;
    }>;
  }>,
): Promise<BrowserFlowResult> {
  try {
    const resolveForm: FlowFormReferenceResolver = (reference) => {
      const type = input.plan.forms[reference.form]?.[reference.field];
      return type === undefined
        ? undefined
        : pageFlowFormValue(type, input.readFormValue(reference.form, reference.field));
    };
    const clock = pageFlowClock(input.timeZone);
    const inputs = resolvePageFlowInputs(input.plan.inputs, input.bindings, input.caller, {
      ...clock,
      reference: (reference) =>
        reference.source === "form"
          ? resolveForm(reference)
          : reference.source === "page"
            ? input.readPageValues()[reference.name]
            : reference.source === "execution_now"
              ? { type: "date_time", value: clock.now }
              : undefined,
    });
    return await runBrowserFlow({
      plan: input.plan,
      start: { runId: input.runId, flowId: input.plan.flowId, inputs, ...clock },
      host: input.host,
      readPageValues: input.readPageValues,
      resolveForm,
      ...(input.condition === undefined ? {} : { condition: input.condition }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.server === undefined
        ? {}
        : {
            server: {
              ...input.server,
              caller: input.caller,
              pageInputs: new Set(
                Object.entries(input.bindings).flatMap(([name, source]) =>
                  typeof source === "object" &&
                  source.kind !== "caller" &&
                  source.kind !== "literal"
                    ? [name]
                    : [],
                ),
              ),
            },
          }),
    });
  } catch (error) {
    console.error("[flow] page input resolution failed", error);
    return { kind: "failed", failure: { outcome: "failed", code: "inputs_invalid" } };
  }
}
