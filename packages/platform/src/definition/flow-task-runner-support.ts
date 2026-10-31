import { recordIdSchema } from "../catalogue/identifiers";
import type { JsonValue } from "../catalogue/common";
import { isRecord } from "../catalogue/runtime-primitives";
import {
  flowRefusalFeedbackSchema,
  type FlowRefusalFeedback,
} from "../workflows/flow-refusal-feedback";
import type { BeforeSaveRuleWarning } from "../rules/before-save-flow-run";
import type { FlowProtectedTaskCall, FlowTaskOutcome } from "../rules/flow-interpreter";
import { refusalOutcome, ruleRefusalResult } from "./flow-orchestrator-support";
import type { Run } from "./flow-orchestrator-types";

export type TaskResult = {
  outcome: FlowTaskOutcome;
  outputs?: Record<string, JsonValue>;
  diagnostic?: FlowRefusalFeedback;
};

/** A saved record effect stores only the record identity, never readable or submitted values. */
export const isSavedRecordEffectOutput = (value: unknown): value is Readonly<{ record: string }> =>
  isRecord(value) &&
  Object.keys(value).every((key) => key === "record" || key === "warnings") &&
  Object.hasOwn(value, "record") &&
  recordIdSchema.safeParse(value.record).success;

export const isEmptyEffectOutput = (value: unknown): boolean =>
  isRecord(value) && Object.keys(value).length === 0;

/** A stored refusal carries its stable code, never rendered correction text. */
export const storedCorrectionDiagnostic = (value: unknown): FlowRefusalFeedback | undefined => {
  if (!isRecord(value) || Object.keys(value).length !== 1) return undefined;
  const parsed = flowRefusalFeedbackSchema.safeParse(value.diagnostic);
  return parsed.success ? parsed.data : undefined;
};

/** A writer refusal ends the task with its own outcome and authored words. */
export const refusedTask = (
  failure:
    | (Readonly<{ outcome: string }> & { error?: Parameters<typeof ruleRefusalResult>[0] })
    | undefined,
) => {
  const error = failure?.outcome === "refused" ? failure.error : undefined;
  return {
    result: {
      outcome: error === undefined ? ("refused" as const) : refusalOutcome(error.code),
      ...(error === undefined ? {} : ruleRefusalResult(error)),
    },
    stored: {},
  };
};

/** Carries only committed saves' authored messages; logs locate the rule without record values. */
export const appendWarnings = (
  run: Run,
  call: FlowProtectedTaskCall,
  warnings: readonly BeforeSaveRuleWarning[] | undefined,
): void => {
  for (const warning of warnings ?? []) {
    run.warnings.push({ taskId: call.taskId, message: warning.message });
    console.warn(
      `[flows] flow ${run.flowId} task ${call.taskId} committed with warning ${warning.code}`,
    );
  }
};

/**
 * Records a task the platform cannot run here: it fails as not available, never as refused.
 * The person sees the message; the server log keeps the cause.
 */
export const notAvailable = (
  run: Run,
  call: FlowProtectedTaskCall,
  message: string,
  cause: string,
): TaskResult => {
  console.warn(
    `[flows] flow ${run.flowId} task ${call.taskId} (${call.taskType}) not available: ${cause}`,
  );
  run.unavailable.push({
    taskId: call.taskId,
    taskType: call.taskType,
    code: "capability_unavailable",
    message,
  });
  return { outcome: "failed" };
};

/** A Call protected operation task's inputs: its own input map, or the flow's inputs by name. */
export const operationInputs = (
  call: FlowProtectedTaskCall,
): Record<string, unknown> | undefined => {
  const suppliedInputs = call.properties.inputs?.value;
  if (suppliedInputs !== undefined && !isRecord(suppliedInputs)) return undefined;
  return isRecord(suppliedInputs)
    ? suppliedInputs
    : Object.fromEntries(
        Object.entries(call.flowInputs).map(([name, value]) => [name, value.value]),
      );
};
