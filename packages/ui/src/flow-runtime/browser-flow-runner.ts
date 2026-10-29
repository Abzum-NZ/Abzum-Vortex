import {
  browserFlowMemberTypeResolver,
  pageFlowFinalOutputs,
  resolvePageFlowInputs,
  pageFlowFormValue,
  type FlowBindingInput,
  type BrowserFlowPlan,
  type FlowFailure,
  type FlowFormReferenceResolver,
  type FlowProgram,
  type FlowRunStart,
  type FlowRunState,
  type JsonValue,
} from "@vortex/platform/schema";
import { drivePageFlowSegment } from "./page-flow-segment";
import { pageFlowClock } from "./page-flow-clock";
import type { FlowIntentHost } from "./intents";

export type BrowserFlowResult =
  | Readonly<{ kind: "completed"; outputs: Readonly<Record<string, JsonValue>> }>
  | Readonly<{ kind: "failed"; failure: FlowFailure }>
  | Readonly<{ kind: "abandoned" }>
  | Readonly<{ kind: "not_page_only" }>;

/** Runs page-only plans with the shared segment interpreter; protected plans stay with the gate. */
export async function runBrowserFlow(
  input: Readonly<{
    plan: BrowserFlowPlan;
    start: FlowRunStart;
    host: FlowIntentHost;
    resolveForm?: FlowFormReferenceResolver;
    signal?: AbortSignal;
  }>,
): Promise<BrowserFlowResult> {
  const { plan, start, host, resolveForm, signal } = input;
  if (
    plan.segments.some((segment) => segment.kind !== "page" || segment.guard.length !== 0) ||
    Object.values(plan.outputs).some(
      ({ value }) => value.kind === "reference" && value.reference.source === "final_output",
    )
  )
    return { kind: "not_page_only" };
  const members = browserFlowMemberTypeResolver(plan);
  const pageSegments = plan.segments.filter((segment) => segment.kind === "page");
  const declaredTasks = pageSegments.flatMap((segment) => segment.tasks);
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
  let failure: FlowFailure | undefined;
  const run = async (tasks: FlowProgram["tasks"]) => {
    const result = await drivePageFlowSegment({
      program: program(tasks),
      start,
      ...(state === undefined ? {} : { previous: state }),
      resolveMember: members,
      ...(resolveForm === undefined ? {} : { resolveForm }),
      host,
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.kind === "finished") state = result.state;
    return result;
  };
  try {
    const main = pageSegments.filter((segment) => segment.section === "tasks");
    for (const segment of main.length === 0 ? [{ tasks: [] }] : main) {
      const result = await run(segment.tasks);
      if (result.kind === "abandoned") return { kind: "abandoned" };
      if (result.kind === "unavailable")
        return { kind: "failed", failure: { outcome: "failed", code: "flow_unavailable" } };
      if (result.result.status === "failed") {
        failure = result.result.failure;
        break;
      }
      if (result.result.stopped !== undefined) {
        break;
      }
    }
    if (failure !== undefined) {
      for (const segment of pageSegments.filter((part) => part.section === "errors")) {
        const result = await run(segment.tasks);
        if (result.kind === "abandoned") return { kind: "abandoned" };
        if (
          result.kind === "unavailable" ||
          (result.kind === "finished" && result.result.status === "failed")
        )
          break;
        if (
          result.kind === "finished" &&
          result.result.status === "completed" &&
          result.result.stopped !== undefined
        )
          break;
      }
    }
    for (const segment of pageSegments.filter((part) => part.section === "finally")) {
      const result = await run(segment.tasks);
      if (result.kind === "abandoned") return { kind: "abandoned" };
      if (result.kind === "unavailable")
        failure ??= { outcome: "failed", code: "flow_unavailable" };
      else if (result.result.status === "failed") failure ??= result.result.failure;
      if (
        result.kind === "unavailable" ||
        result.result.status === "failed" ||
        result.result.stopped !== undefined
      )
        break;
    }
    if (failure !== undefined) return { kind: "failed", failure };
    if (state === undefined) throw new Error("FLOW_PAGE_STATE_UNAVAILABLE");
    return {
      kind: "completed",
      outputs: pageFlowFinalOutputs(state, program([]), plan, {}, members, resolveForm),
    };
  } catch (error) {
    console.error("[flow] page-only run failed", error);
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
    signal?: AbortSignal;
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
          : reference.source === "execution_now"
            ? { type: "date_time", value: clock.now }
            : undefined,
    });
    return await runBrowserFlow({
      plan: input.plan,
      start: { runId: input.runId, flowId: input.plan.flowId, inputs, ...clock },
      host: input.host,
      resolveForm,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    console.error("[flow] page input resolution failed", error);
    return { kind: "failed", failure: { outcome: "failed", code: "inputs_invalid" } };
  }
}
