import type { JsonValue } from "../catalogue/common";
import { isRecord } from "../catalogue/runtime-primitives";
import type {
  FlowProtectedTaskCall,
  FlowRunState,
  FlowTaskOutcome,
} from "../rules/flow-interpreter";
import type { FlowRefusalFeedback } from "../workflows/flow-refusal-feedback";
import type { FlowTraceCollector } from "./flow-test-trace";
import type { Run } from "./flow-orchestrator-types";

type TaskResult = {
  outcome: FlowTaskOutcome;
  outputs?: Record<string, JsonValue>;
  diagnostic?: FlowRefusalFeedback;
};
type TracedRunner = {
  run(run: Run, state: FlowRunState, call: FlowProtectedTaskCall): Promise<TaskResult>;
  runSegmentTask(
    run: Run,
    state: FlowRunState,
    call: FlowProtectedTaskCall,
  ): Promise<{ result: TaskResult }>;
  runSegmentSet(
    run: Run,
    state: FlowRunState,
    step: { calls: readonly FlowProtectedTaskCall[] },
  ): Promise<{ result: TaskResult }>;
};

/** The same runner, reporting each protected step it runs to a test run's trace. */
export const tracedTaskRunner = <Runner extends TracedRunner>(
  trace: FlowTraceCollector,
  runner: Runner,
): Runner => {
  const report = (
    run: Run,
    state: FlowRunState,
    call: FlowProtectedTaskCall,
    started: number,
    result: TaskResult,
    outputs: Readonly<Record<string, JsonValue>> | undefined,
  ): void =>
    trace.runner({
      notRun: trace.takeSkip(call.taskPath, call.iteration),
      flowId: state.activations.at(-1)?.flowId ?? run.flowId,
      taskId: call.taskId,
      taskType: call.taskType,
      iteration: call.iteration,
      started,
      outcome: result.outcome,
      outputs,
      diagnostic: result.diagnostic,
      sensitive: run.sensitive,
    });
  return Object.freeze({
    ...runner,
    run: async (run: Run, state: FlowRunState, call: FlowProtectedTaskCall) => {
      const started = performance.now();
      const result = await runner.run(run, state, call);
      report(run, state, call, started, result, result.outputs);
      return result;
    },
    runSegmentTask: async (run: Run, state: FlowRunState, call: FlowProtectedTaskCall) => {
      const started = performance.now();
      const executed = await runner.runSegmentTask(run, state, call);
      report(run, state, call, started, executed.result, executed.result.outputs);
      return executed;
    },
    runSegmentSet: async (
      run: Run,
      state: FlowRunState,
      step: { calls: readonly FlowProtectedTaskCall[] },
    ) => {
      const started = performance.now();
      const executed = await runner.runSegmentSet(run, state, step);
      const produced = executed.result.outputs?.set;
      step.calls.forEach((call: FlowProtectedTaskCall, index: number) =>
        report(
          run,
          state,
          call,
          started,
          executed.result,
          Array.isArray(produced) && isRecord(produced[index])
            ? (produced[index] as Record<string, JsonValue>)
            : {},
        ),
      );
      return executed;
    },
  }) as Runner;
};
