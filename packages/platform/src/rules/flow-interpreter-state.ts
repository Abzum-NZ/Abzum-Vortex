import { describeFailure } from "../catalogue/runtime-primitives";
import type { JsonValue } from "../catalogue/common";
import { typedValueMatchesType } from "./condition-types";
import type { FlowRuntimeValue } from "./flow-formula";
import { flowTaskRegistry } from "../workflows/flow-task-registry";
import type {
  Activation,
  Frame,
  FlowFailure,
  FlowFailureCode,
  FlowFailureOutcome,
  FlowRunState,
  FlowRunStart,
  FlowRuntimeValues,
  FlowTaskTraceObservation,
  FlowTaskTraceObserver,
} from "./flow-interpreter";
import type { FlowDefinition } from "../workflows/flow-contracts";

export const flowRunStateVersion = "1" as const;

export const initialState = (start: FlowRunStart): FlowRunState => ({
  version: flowRunStateVersion,
  runId: start.runId,
  now: start.now,
  ...(start.actor === undefined ? {} : { actor: start.actor }),
  ...(start.subject === undefined ? {} : { subject: start.subject }),
  activations: [],
  protectedOperations: 0,
  committedEffects: 0,
  steps: 0,
  pendingIntents: [],
  ...(start.triggerRecord === undefined ? {} : { triggerRecord: start.triggerRecord }),
  ...(start.previousRecord === undefined ? {} : { previousRecord: start.previousRecord }),
});

export const initialVariables = (flow: FlowDefinition): FlowRuntimeValues =>
  Object.fromEntries(
    Object.entries(flow.variables).map(([name, declaration]) => [
      name,
      { type: declaration.type, value: declaration.default ?? null },
    ]),
  );

export const newActivation = (
  flow: FlowDefinition,
  inputs: FlowRuntimeValues,
  prefix: string,
  callTaskId?: string,
): FlowRunState["activations"][number] => ({
  flowId: flow.id,
  prefix,
  ...(callTaskId === undefined ? {} : { callTaskId }),
  inputs,
  variables: initialVariables(flow),
  outputs: {},
  phase: "tasks",
  frames: [{ path: ["tasks"], index: 0 }],
});

export type PathSegment = string | number;

export const pathKey = (path: readonly PathSegment[]): string => path.join("/");

export const at = (root: unknown, path: readonly PathSegment[]): unknown =>
  path.reduce<unknown>(
    (current, segment) =>
      current !== null && typeof current === "object"
        ? (current as Record<PathSegment, unknown>)[segment]
        : undefined,
    root,
  );

/** The iteration key: every loop position on the call stack, or `0` outside any loop. */
export const iterationKey = (state: FlowRunState): string => {
  const positions = state.activations.flatMap((activation) =>
    activation.frames.flatMap((frame) => (frame.loop === undefined ? [] : [frame.loop.iteration])),
  );
  return positions.length === 0 ? "0" : positions.join(".");
};

export class Failed extends Error {
  constructor(readonly failure: FlowFailure) {
    super(failure.code);
  }
}

export const failed = (
  code: FlowFailureCode,
  outcome: FlowFailureOutcome,
  taskId?: string,
  reason?: string,
): never => {
  throw new Failed({
    outcome,
    code,
    ...(taskId === undefined ? {} : { taskId }),
    ...(reason === undefined ? {} : { reason }),
  });
};

/** An observer cannot change execution, even when its diagnostic callback fails. */
export const observe = (
  observer: FlowTaskTraceObserver | undefined,
  observation: FlowTaskTraceObservation,
): void => {
  try {
    observer?.(observation);
  } catch (error) {
    console.error(
      `[flows] trace observer failed FLOW_TRACE_OBSERVER_FAILED: ${describeFailure(error)}`,
    );
  }
};

// ─── Values ───────────────────────────────────────────────────────────────────────────────────

const typed = (type: string, value: JsonValue): FlowRuntimeValue => ({ type, value });

export const withFrames = (activation: Activation, frames: readonly Frame[]): Activation => ({
  ...activation,
  frames,
});

export const advanceFrame = (activation: Activation): Activation =>
  withFrames(activation, [
    ...activation.frames.slice(0, -1),
    {
      ...activation.frames[activation.frames.length - 1]!,
      index: activation.frames[activation.frames.length - 1]!.index + 1,
    },
  ]);

export const pushFrame = (activation: Activation, frame: Frame): Activation =>
  withFrames(activation, [...activation.frames, frame]);

/** Records the first failure of an activation and leaves the task list. */
export const failActivation = (activation: Activation, failure: FlowFailure): Activation => {
  const recorded = activation.failure ?? failure;
  return { ...activation, failure: recorded, frames: [] };
};

export const stringOutcomeOutputs = (outcome: string): FlowRuntimeValues => ({
  outcome: typed("text", outcome),
});

export const storeTaskOutputs = (
  activation: Activation,
  taskId: string,
  outputs: FlowRuntimeValues,
): Activation => ({ ...activation, outputs: { ...activation.outputs, [taskId]: outputs } });

const outputTypes = (taskType: string): Readonly<Record<string, string>> =>
  Object.fromEntries(
    (flowTaskRegistry[taskType as keyof typeof flowTaskRegistry]?.outputs ?? []).map((output) => [
      output.key,
      output.type,
    ]),
  );

export const declaredOutputs = (
  taskType: string,
  produced: Readonly<Record<string, JsonValue>> | undefined,
): FlowRuntimeValues => {
  const declared = outputTypes(taskType);
  const outputs: Record<string, FlowRuntimeValue> = {};
  for (const [key, type] of Object.entries(declared)) {
    const value = produced?.[key];
    if (value === undefined || value === null) continue;
    if (typedValueMatchesType(value, type, "flow")) outputs[key] = typed(type, value);
  }
  return outputs;
};
