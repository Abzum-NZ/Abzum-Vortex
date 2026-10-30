import type { JsonValue } from "../catalogue/common";
import type { FlowRefusalFeedback } from "../workflows/flow-refusal-feedback";
import type {
  FlowFailure,
  FlowTaskOutcome,
  FlowTaskTraceObservation,
  FlowTaskTraceObserver,
} from "../rules/flow-interpreter";

/** Where a step ran in a test run. */
export type FlowTraceLocation = "page" | "server" | "back end";

/** Why a step was not run in a test run. */
export type FlowTraceNotRun =
  | "multi_transaction"
  | "access_change"
  | "scope_lock"
  | "external_effect"
  | "needs_a_person"
  | "action_event";

/** What a refused or failed step reports; the host words it exactly as a user would read it. */
type FlowTraceRefusal = Readonly<{
  outcome: string;
  failureCode?: string;
  diagnostic?: FlowRefusalFeedback;
  ruleRefusalMessage?: string;
}>;

/** One step of a test run, in the order it was reached. */
export type FlowTraceStep = Readonly<{
  flowId: string;
  taskId: string;
  taskType: string;
  iteration: string;
  location: FlowTraceLocation;
  /** `completed` for a step the interpreter finished without a runner. */
  outcome: FlowTaskOutcome | "completed" | "paused" | "not_run";
  ms: number;
  /** The step's outputs; held sensitive values are masked. */
  outputs: Readonly<Record<string, JsonValue>>;
  notRun?: FlowTraceNotRun;
  refusal?: FlowTraceRefusal;
}>;

const maskedValue = "••••••";

const mask = (value: JsonValue, sensitive: readonly string[]): JsonValue => {
  if (typeof value === "string")
    return sensitive.some((held) => held.length > 0 && value.includes(held)) ? maskedValue : value;
  if (Array.isArray(value)) return value.map((entry) => mask(entry, sensitive));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [name, mask(entry as JsonValue, sensitive)]),
    );
  return value;
};

/**
 * Collects a test run's steps. The interpreter reports every step it finishes itself; the task
 * runner reports every step that ran through a protected path. Normal runs have no collector.
 */
export const createFlowTraceCollector = (
  locate: (flowId: string, taskId: string, backEnd: boolean) => FlowTraceLocation,
  clock: () => number = () => performance.now(),
) => {
  const steps: FlowTraceStep[] = [];
  const skipped = new Map<string, FlowTraceNotRun>();
  let backEndDepth = 0;
  let last = clock();
  const lap = (): number => {
    const now = clock();
    const ms = Math.round((now - last) * 100) / 100;
    last = now;
    return ms;
  };

  const observer: FlowTaskTraceObserver = (observation: FlowTaskTraceObservation) => {
    // Protected steps are reported by the runner with their outputs; every other step ends here.
    if (observation.outcome === "entered" || observation.outcome === "awaiting") return;
    const failure: FlowFailure | undefined = observation.failure;
    steps.push({
      flowId: observation.flowId,
      taskId: observation.taskId,
      taskType: observation.taskType,
      iteration: observation.iteration,
      location: locate(observation.flowId, observation.taskId, backEndDepth > 0),
      outcome:
        observation.outcome === "failed"
          ? failure?.outcome === "failed" || failure?.outcome === "uncertain"
            ? "failed"
            : "refused"
          : observation.taskType === "interface.show_form" ||
              observation.taskType === "interface.confirm"
            ? "paused"
            : "completed",
      ms: lap(),
      outputs: {},
      ...(failure === undefined
        ? {}
        : {
            refusal: {
              outcome: failure.outcome,
              failureCode: failure.code,
              ...(failure.diagnostic === undefined ? {} : { diagnostic: failure.diagnostic }),
              ...(failure.ruleRefusal === undefined
                ? {}
                : { ruleRefusalMessage: failure.ruleRefusal.message }),
            },
          }),
    });
  };

  return {
    observer,
    steps: (): readonly FlowTraceStep[] => steps,
    /** A protected step the test run will not run; its runner report then says why. */
    skip: (taskPath: string, iteration: string, reason: FlowTraceNotRun): void => {
      skipped.set(JSON.stringify([taskPath, iteration]), reason);
    },
    takeSkip: (taskPath: string, iteration: string): FlowTraceNotRun | undefined => {
      const key = JSON.stringify([taskPath, iteration]);
      const reason = skipped.get(key);
      skipped.delete(key);
      return reason;
    },
    /** An after-save subscriber's run ended: its flow, how, and the code that names a failure. */
    subscriber: (
      flowId: string,
      flowKey: string,
      outcome: "succeeded" | "refused" | "failed",
      failureCode: string | undefined,
      started: number,
    ): void => {
      steps.push({
        flowId,
        taskId: flowKey,
        taskType: "after_save_subscriber",
        iteration: "",
        location: "back end",
        outcome: outcome === "succeeded" ? "completed" : outcome,
        ms: Math.round((clock() - started) * 100) / 100,
        outputs: {},
        ...(failureCode === undefined ? {} : { refusal: { outcome, failureCode } }),
      });
    },
    /** A subscriber to an event a named action announced: the test run does not deliver it. */
    subscriberNotRun: (flowId: string, flowKey: string): void => {
      steps.push({
        flowId,
        taskId: flowKey,
        taskType: "after_save_subscriber",
        iteration: "",
        location: "back end",
        outcome: "not_run",
        ms: 0,
        outputs: {},
        notRun: "action_event",
      });
    },
    /** A step of a segment the test run cannot run at all. */
    notRun: (
      flowId: string,
      task: Readonly<{ id: string; type: string }>,
      reason: FlowTraceNotRun,
    ): void => {
      steps.push({
        flowId,
        taskId: task.id,
        taskType: task.type,
        iteration: "",
        location: locate(flowId, task.id, backEndDepth > 0),
        outcome: "not_run",
        ms: 0,
        outputs: {},
        notRun: reason,
      });
    },
    /** A protected step has run (or was skipped): its result, with the outputs masked. */
    runner: (
      step: Readonly<{
        flowId: string;
        taskId: string;
        taskType: string;
        iteration: string;
        started: number;
        outcome: FlowTaskOutcome;
        outputs: Readonly<Record<string, JsonValue>> | undefined;
        diagnostic: FlowRefusalFeedback | undefined;
        sensitive: readonly string[];
        notRun?: FlowTraceNotRun | undefined;
      }>,
    ): void => {
      const refused = step.outcome !== "completed" && step.outcome !== "committed";
      const ms = Math.round((clock() - step.started) * 100) / 100;
      last = clock();
      steps.push({
        flowId: step.flowId,
        taskId: step.taskId,
        taskType: step.taskType,
        iteration: step.iteration,
        location: locate(step.flowId, step.taskId, backEndDepth > 0),
        outcome: step.notRun === undefined ? step.outcome : "not_run",
        ms,
        outputs: mask((step.outputs ?? {}) as JsonValue, step.sensitive) as Record<
          string,
          JsonValue
        >,
        ...(step.notRun === undefined ? {} : { notRun: step.notRun }),
        ...(refused && step.notRun === undefined
          ? {
              refusal: {
                outcome: step.outcome,
                ...(step.diagnostic === undefined ? {} : { diagnostic: step.diagnostic }),
              },
            }
          : {}),
      });
    },
    /** Steps reached inside a back-end child run report their location as the back end. */
    insideBackEnd: async <Result>(operation: () => Promise<Result>): Promise<Result> => {
      backEndDepth += 1;
      try {
        return await operation();
      } finally {
        backEndDepth -= 1;
      }
    },
  };
};

export type FlowTraceCollector = ReturnType<typeof createFlowTraceCollector>;
