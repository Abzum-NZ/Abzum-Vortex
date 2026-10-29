import type {
  FlowFailure,
  FlowFailureCode,
  FlowFailureOutcome,
  FlowRunState,
} from "./flow-interpreter";

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

// ─── Values ───────────────────────────────────────────────────────────────────────────────────
