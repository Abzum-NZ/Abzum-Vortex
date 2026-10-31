import { flowPathGuardMatches } from "./flow-path-guard";
import type { FlowPlan } from "../workflows/flow-plan";
import type { parseFlowSegmentSeed } from "./flow-segment-seed";
import {
  at,
  Failed,
  failed,
  initialState,
  newActivation,
  flowRunStateVersion,
} from "./flow-interpreter-state";
import {
  buildInputs,
  clone,
  drive,
  evaluateValue,
  failedStep,
  finishActivation,
  scopeOf,
  snapshot,
  startFlowRun,
  type Machine,
} from "./flow-interpreter-core";
import type {
  Activation,
  FlowFormReferenceResolver,
  FlowLibrary,
  FlowOutputMemberTypeResolver,
  FlowProgram,
  FlowProgramLibrary,
  FlowRunStart,
  FlowRunState,
  FlowRunStep,
  FlowSegmentReplay,
} from "./flow-interpreter-types";

/** Starts the admitted server segment with the host's binding inputs and validated page values. */
export const startFlowSegment = (
  plan: FlowPlan,
  segmentId: string,
  start: FlowRunStart,
  seed: Readonly<Record<string, unknown>>,
  library: FlowLibrary,
  resolveMember: FlowOutputMemberTypeResolver,
  parseSeed: typeof parseFlowSegmentSeed,
  replay?: FlowSegmentReplay,
): FlowRunStep => {
  const state = initialState(start);
  const machine: Machine = { state: { ...state }, library, resolveMember };
  const segment = plan.segments.find((part) => part.kind === "server" && part.id === segmentId);
  if (
    segment === undefined ||
    segment.kind !== "server" ||
    start.flowId !== plan.flowId ||
    library(start.flowId) !== plan.definition
  )
    return failedStep(machine, { outcome: "refused", code: "flow_unavailable" });
  const flow = plan.definition;
  if (flow.execution !== "interactive")
    return failedStep(machine, { outcome: "refused", code: "flow_not_runnable" });
  try {
    const parsed = parseSeed(flow, segment, seed, start);
    if (Object.keys(parsed.inputs).some((name) => Object.hasOwn(start.inputs, name)))
      failed("inputs_invalid", "refused", undefined, "page input overrides a server binding");
    const requiredInputs = new Set(
      Object.keys(segment.inputs)
        .filter((name) => name.startsWith("inputs."))
        .map((name) => name.slice(7)),
    );
    const inputs = buildInputs(
      flow,
      { ...start.inputs, ...parsed.inputs },
      undefined,
      requiredInputs,
    );
    const { variables, outputs, forms } = parsed;
    const completion = segment.tasks.length === 0;
    if (completion && segment.firstTaskPath.length !== 0)
      failed("inputs_invalid", "refused", undefined, "completion segment has invalid tasks");
    machine.state.forms = forms;
    const taskPath = segment.firstTaskPath;
    const index = taskPath.at(-1);
    if (!completion && typeof index !== "number")
      return failedStep(machine, { outcome: "refused", code: "flow_unavailable" });
    if (!completion && (taskPath[0] !== segment.section || at(flow, taskPath) !== segment.tasks[0]))
      failed("flow_unavailable", "refused", undefined, "segment location is invalid");
    const activation: Activation = {
      ...newActivation(flow, inputs, ""),
      variables,
      outputs,
      phase: segment.section,
      frames: completion ? [] : [{ path: taskPath.slice(0, -1), index: index as number }],
    };
    machine.state.activations = [activation];
    machine.segment = segment;
    if (replay !== undefined) machine.replay = replay;
    if (
      !flowPathGuardMatches(
        segment.guard,
        scopeOf(machine.state, activation, flow, resolveMember),
        (value, task) => evaluateValue(value, machine.state, activation, flow, task, resolveMember),
      )
    )
      failed("inputs_invalid", "refused", undefined, "segment path does not match");
    return completion
      ? {
          kind: "boundary",
          state: snapshot(machine),
          result: finishActivation(machine, activation),
        }
      : drive(machine);
  } catch (error) {
    if (error instanceof Failed) return failedStep(machine, error.failure);
    throw error;
  }
};

/**
 * Starts one detached page segment, retaining the preceding segment's typed activation. The page
 * driver chooses the segment and its phase; the interpreter still executes its task tree. Final
 * outputs and the next phase are handled by the driver after all selected segments have run.
 */
export const startPageFlowSegment = (
  program: FlowProgram,
  start: FlowRunStart,
  resolveMember: FlowOutputMemberTypeResolver,
  previous?: FlowRunState,
  resolveForm?: FlowFormReferenceResolver,
): FlowRunStep => {
  const library: FlowProgramLibrary = (id) => (id === program.id ? program : undefined);
  if (
    program.execution !== "interactive" ||
    program.errors.length !== 0 ||
    program.finally.length !== 0 ||
    Object.keys(program.outputs).length !== 0
  )
    throw new Error("FLOW_PAGE_SEGMENT_PROGRAM_INVALID");
  if (previous === undefined)
    return startFlowRun(start, library, resolveMember, undefined, resolveForm);
  const machine: Machine = {
    state: {
      ...clone(previous),
      ...(start.pageValues === undefined ? {} : { pageValues: start.pageValues }),
    },
    library,
    resolveMember,
    ...(resolveForm === undefined ? {} : { resolveForm }),
  };
  const activation = machine.state.activations[0];
  if (
    previous.version !== flowRunStateVersion ||
    previous.runId !== start.runId ||
    previous.awaiting !== undefined ||
    previous.activations.length !== 1 ||
    activation === undefined ||
    activation.flowId !== program.id ||
    activation.frames.length !== 0
  )
    return failedStep(machine, { outcome: "failed", code: "resume_mismatch" });
  const retained: { -readonly [Key in keyof Activation]: Activation[Key] } = { ...activation };
  delete retained.failure;
  delete retained.stopped;
  machine.state.activations = [
    { ...retained, phase: "tasks", frames: [{ path: ["tasks"], index: 0 }] },
  ];
  return drive(machine);
};
