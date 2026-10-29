import "server-only";

import type { IdentitySession, OrganizationSelectionCandidate } from "../access/identity-access";
import type { ExecuteNamedActionCommand } from "../records/named-actions";
import {
  resumeFlowRun,
  type FlowRunResume,
  type FlowRunStep,
  type FlowTaskOutcome,
} from "../rules/flow-interpreter";
import type { BeforeSaveRuleWarning } from "../rules/before-save-flow-run";
import type { FlowServerSegment } from "../workflows/flow-plan";
import type { FlowSegmentReceipt } from "../workflows/start";
import { createFlowTaskRunner } from "./flow-task-runner";
import type {
  FlowOrchestratorDependencies,
  NamedActionExecutionResult,
  Run,
} from "./flow-orchestrator-types";

/** Runs only the admitted segment. The host constructs a fresh frame and bound ports per attempt. */
export const runFlowSegment = async (
  dependencies: FlowOrchestratorDependencies,
  runNamedAction: (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    command: ExecuteNamedActionCommand,
  ) => Promise<NamedActionExecutionResult>,
  run: Run,
  segment: FlowServerSegment,
  first: FlowRunStep,
  receipt?: FlowSegmentReceipt,
): Promise<
  Readonly<{
    step: FlowRunStep;
    outcome: "succeeded" | "refused" | "failed";
    effects: Readonly<
      Record<
        string,
        Readonly<{
          outcome: FlowTaskOutcome;
          replay: Extract<FlowRunResume, { kind: "task_result" }> | null;
        }>
      >
    >;
    warnings: Readonly<Record<string, readonly BeforeSaveRuleWarning[]>>;
  }>
> => {
  const runner = createFlowTaskRunner(dependencies, runNamedAction);
  const effects: Record<
    string,
    { outcome: FlowTaskOutcome; replay: Extract<FlowRunResume, { kind: "task_result" }> | null }
  > = {};
  const warnings: Record<string, readonly BeforeSaveRuleWarning[]> = {};
  let step = first;
  while (step.kind === "protected_task") {
    const key = JSON.stringify([step.call.taskPath, step.call.iteration]);
    let result: Extract<FlowRunResume, { kind: "task_result" }>;
    if (step.replay !== undefined) {
      if (step.replay.kind !== "task_result" || receipt === undefined)
        throw new Error("FLOW_SEGMENT_REPLAY_INVALID");
      const replay = await runner.replaySegmentTask(
        run,
        step.state,
        step.call,
        step.replay,
        receipt.warnings[key] ?? [],
      );
      if (replay?.kind !== "task_result") throw new Error("FLOW_SEGMENT_REPLAY_UNAVAILABLE");
      result = replay;
    } else {
      const executed = await runner.runSegmentTask(run, step.state, step.call);
      result = { kind: "task_result", ...executed.result };
      if (executed.replay !== undefined) {
        if (receipt !== undefined) throw new Error("FLOW_SEGMENT_REPLAY_RAN_EFFECT");
        effects[key] = { outcome: executed.result.outcome, replay: executed.replay };
        if (executed.warnings.length > 0) warnings[key] = executed.warnings;
      }
    }
    step = resumeFlowRun(step.state, result, run.library, undefined, segment, receipt?.effects);
  }
  const failure =
    (step.kind === "finished" || step.kind === "boundary") && step.result?.status === "failed"
      ? step.result.failure
      : undefined;
  const outcome =
    failure === undefined
      ? "succeeded"
      : failure.outcome === "failed" || failure.outcome === "uncertain"
        ? "failed"
        : "refused";
  return { step, outcome, effects, warnings };
};
