import type { JsonValue } from "../catalogue/common";
import type { FlowDefinition, FlowTask } from "../workflows/flow-contracts";
import { flowRuntimeValueOf, retypeTasks } from "./action-flow-run";
import { startFlowRun, type FlowRuntimeValues } from "./flow-interpreter";

/**
 * Runs the `BeforeSave` flows of one record type for one save attempt with the one flow
 * interpreter. The flows are the compiled `transaction` flows of the exact Module release
 * the save resolved; nothing here reads a record, a release or a session. The interpreter reports
 * the warnings and requirements the rule tasks raise and the refusal of the first `rule.refuse`
 * that runs, and this host turns them into the save's outcome. Requirements are declarations for
 * Record to check after the owning generators have produced the final candidate.
 */

export type BeforeSaveRuleRequirement = Readonly<{
  ruleKey: string;
  fieldId: string;
  code: string;
  message: string;
}>;

export type BeforeSaveRuleWarning = Readonly<{
  code: string;
  message: string;
}>;

export type BeforeSaveRuleRefusal = Readonly<{
  ruleKey: string;
  code: string;
  message: string;
  fieldId?: string;
  cause: Readonly<{ part: string; reason: string }>;
}>;

/** A flow that cannot be run to its end; the save is refused, never run without its flows. */
export class BeforeSaveFlowEvaluationError extends Error {
  constructor(readonly detail: string) {
    super(`vortex.rule.before_save_flow_unavailable: ${detail}`);
    this.name = "BeforeSaveFlowEvaluationError";
  }
}

export type EvaluateBeforeSaveFlowsInput = Readonly<{
  /** The compiled BeforeSave flows of the record type's Module release. */
  flows: readonly FlowDefinition[];
  recordTypeId: string;
  fields: readonly Readonly<{ fieldId: string; key: string; type: string }>[];
  operation: "create" | "update";
  /** The candidate values the save would write, keyed by field identity. */
  candidateValues: Readonly<Record<string, JsonValue>>;
  /** The stored values before an update, keyed by field identity. */
  previousValues?: Readonly<Record<string, JsonValue>>;
  now: string;
}>;

export type EvaluateBeforeSaveFlowsResult =
  | Readonly<{
      success: true;
      requirements: readonly BeforeSaveRuleRequirement[];
      warnings: readonly BeforeSaveRuleWarning[];
    }>
  | Readonly<{
      success: false;
      refusal: BeforeSaveRuleRefusal;
      warnings: readonly BeforeSaveRuleWarning[];
    }>;

type Trigger = Extract<FlowDefinition["triggers"][number], { type: "BeforeSave" }>;

const recordView = (
  fields: EvaluateBeforeSaveFlowsInput["fields"],
  values: Readonly<Record<string, JsonValue>> | undefined,
): FlowRuntimeValues =>
  Object.fromEntries(
    fields.map((field) => [
      field.key,
      flowRuntimeValueOf(
        field.type,
        values !== undefined && Object.hasOwn(values, field.fieldId) ? values[field.fieldId] : null,
      ),
    ]),
  );

/** The tasks the run starts with: the trigger's entry condition, when present, guards them all. */
const guardedTasks = (flow: FlowDefinition, trigger: Trigger): FlowTask[] =>
  trigger.condition === undefined
    ? flow.tasks
    : [
        {
          id: "trigger_condition",
          type: "if",
          condition: trigger.condition,
          then: flow.tasks,
        },
      ];

/** Every (flow, trigger) pair that covers the record type and operation, in run order. */
const applicable = (input: EvaluateBeforeSaveFlowsInput) =>
  input.flows
    .flatMap((flow) =>
      flow.triggers.flatMap((trigger) =>
        trigger.type === "BeforeSave" &&
        trigger.recordTypeId.toLowerCase() === input.recordTypeId.toLowerCase() &&
        trigger.operations.some((operation) => operation.kind === input.operation)
          ? [{ flow, trigger }]
          : [],
      ),
    )
    // Stable sort retains the compiler's source order for flows with equal priority.
    .sort((left, right) => left.trigger.priority - right.trigger.priority);

export const evaluateBeforeSaveFlows = (
  input: EvaluateBeforeSaveFlowsInput,
): EvaluateBeforeSaveFlowsResult => {
  const triggerRecord = recordView(input.fields, input.candidateValues);
  // A create has no stored record: every previous value is empty.
  const previousRecord = recordView(input.fields, input.previousValues);
  const requirements: BeforeSaveRuleRequirement[] = [];
  const warnings: BeforeSaveRuleWarning[] = [];

  for (const { flow, trigger } of applicable(input)) {
    const runnable: FlowDefinition = {
      ...flow,
      tasks: retypeTasks(guardedTasks(flow, trigger), { triggerRecord, previousRecord }),
    };
    const step = startFlowRun(
      {
        runId: `before-save:${flow.id}`,
        flowId: flow.id,
        inputs: {},
        now: input.now,
        executionKinds: ["transaction"],
        triggerRecord,
        previousRecord,
      },
      (flowId) => (flowId === flow.id ? runnable : undefined),
    );
    if (step.kind !== "finished")
      throw new BeforeSaveFlowEvaluationError(
        `flow ${flow.id} stopped for a ${step.kind} step, which a save cannot answer`,
      );
    for (const feedback of step.state.ruleFeedback ?? []) {
      if (feedback.kind === "warn")
        warnings.push({ code: feedback.taskId, message: feedback.message });
      else if (feedback.field !== undefined)
        requirements.push({
          ruleKey: flow.key,
          fieldId: feedback.field,
          code: feedback.taskId,
          message: feedback.message,
        });
    }
    if (step.result.status === "completed") continue;
    const { failure } = step.result;
    if (failure.code === "task_refused" && failure.ruleRefusal !== undefined) {
      const cause = { part: flow.id, reason: failure.taskId ?? failure.ruleRefusal.reason };
      console.info("[before-save-flow] refused", { cause, code: failure.ruleRefusal.reason });
      return {
        success: false,
        refusal: {
          ruleKey: flow.key,
          code: failure.ruleRefusal.reason,
          message: failure.ruleRefusal.message,
          cause,
          ...(failure.ruleRefusal.field === undefined
            ? {}
            : { fieldId: failure.ruleRefusal.field }),
        },
        warnings,
      };
    }
    throw new BeforeSaveFlowEvaluationError(
      `flow ${flow.id} failed (${failure.code}) at task ${failure.taskId ?? "(none)"}${
        failure.reason === undefined ? "" : `: ${failure.reason}`
      }`,
    );
  }
  return { success: true, requirements, warnings };
};
