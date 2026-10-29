import { describeFailure } from "../catalogue/runtime-primitives";
import type {
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
