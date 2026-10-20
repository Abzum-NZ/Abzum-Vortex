import "server-only";
import { z } from "zod";

import {
  describeFailure,
  flowSchema,
  type FlowDefinition,
  type JsonValue,
  type RecordTypeDefinition,
} from "../schema";
import {
  BeforeSaveFlowEvaluationError,
  evaluateBeforeSaveFlows,
  type BeforeSaveRuleRequirement,
  type BeforeSaveRuleWarning,
} from "../rules/index";
import {
  prepareInitialRecordFieldCandidate,
  type InitialRecordFieldCandidate,
} from "./field-values";

/** Code of the correction issue a deliberate rule refusal raises (located on a field when it names one). */
export const beforeSaveRuleRefusedIssueCode = "before_save_rule_refused";
/** Code of the issue raised when rules could not be reached or evaluated; the save is refused, never skipped. */
export const beforeSaveRuleUnavailableIssueCode = "before_save_rule_unavailable";

/**
 * The compiled BeforeSave flows of one exact Module release that name the
 * saved record type. The database preparation reads them from the same
 * immutable release row the save already resolved, so no caller input can
 * supply or replace them.
 */
type BeforeSaveFlowSet = Readonly<{
  moduleRootId: string;
  releaseRevision: number;
  flows: readonly FlowDefinition[];
}>;

/**
 * Per-attempt rule execution. `warnings` is filled by the single evaluation of
 * that attempt so the caller can carry them to the save outcome.
 */
export type BeforeSaveRuleExecution = Readonly<{
  ruleSet: BeforeSaveFlowSet;
  warnings: BeforeSaveRuleWarning[];
}>;

export const beginBeforeSaveRuleExecution = (
  ruleSet: BeforeSaveFlowSet,
): BeforeSaveRuleExecution => ({
  ruleSet,
  warnings: [],
});

type BeforeSaveRuleApplication =
  | Readonly<{
      success: true;
      candidateValues: Readonly<Record<string, JsonValue>>;
      requirements: readonly BeforeSaveRuleRequirement[];
    }>
  | Readonly<{
      success: false;
      reason: "refused";
      ruleKey: string;
      code: string;
      message: string;
      fieldId?: string;
      cause: Readonly<{ part: string; reason: string }>;
    }>
  | Readonly<{ success: false; reason: "unavailable" }>;

/**
 * Parses the `beforeSaveFlows` a preparation returned. Anything that is not the
 * exact closed shape for this record type, including a flow that is not a
 * compiled BeforeSave flow of it, is unreachable and yields `undefined`; the
 * caller must then refuse the save rather than run it without its flows.
 */
const beforeSaveFlowSetSchema = z
  .object({
    moduleRootId: z.uuid(),
    releaseRevision: z.number().int().positive().safe(),
    flows: z.array(flowSchema),
  })
  .strict();

export const parseBeforeSaveFlowSet = (
  candidate: unknown,
  recordTypeId: string,
): BeforeSaveFlowSet | undefined => {
  const parsed = beforeSaveFlowSetSchema.safeParse(candidate);
  if (!parsed.success) {
    console.error("[before-save-flow] preparation contract failed", {
      cause: { part: "beforeSaveFlows", reason: "invalid_preparation" },
      issues: parsed.error.issues.map(({ path, code, message }) => ({ path, code, message })),
    });
    return undefined;
  }
  for (const flow of parsed.data.flows) {
    // A flow for another subject would be silently skipped by the evaluator.
    if (
      flow.execution !== "transaction" ||
      !flow.triggers.some(
        (trigger) =>
          trigger.type === "BeforeSave" &&
          trigger.recordTypeId.toLowerCase() === recordTypeId.toLowerCase(),
      )
    ) {
      console.error("[before-save-flow] preparation subject mismatch", {
        cause: { part: flow.id, reason: "wrong_record_type_or_execution" },
      });
      return undefined;
    }
  }
  return parsed.data;
};

/**
 * Runs every applicable BeforeSave flow once against one save attempt's initial
 * candidate and returns the candidate plus the requirements the final field
 * policy must satisfy. A flow does not change the candidate.
 */
export const applyBeforeSaveRules = (input: {
  execution: BeforeSaveRuleExecution;
  recordType: RecordTypeDefinition;
  initialCandidate: InitialRecordFieldCandidate;
  organizationCurrency?: string;
}): BeforeSaveRuleApplication => {
  const { execution, recordType, initialCandidate } = input;
  execution.warnings.length = 0;
  if (execution.ruleSet.flows.length === 0)
    return { success: true, candidateValues: initialCandidate.candidateValues, requirements: [] };

  let previousValues: Readonly<Record<string, JsonValue>> | undefined;
  if (initialCandidate.operation === "update") {
    // The stored values normalized exactly as the candidate's own existing values are.
    const previous = prepareInitialRecordFieldCandidate({
      operation: "update",
      recordType,
      submittedValues: {},
      existingValues: initialCandidate.originalValues,
      ...(input.organizationCurrency === undefined
        ? {}
        : { organizationCurrency: input.organizationCurrency }),
    });
    if (!previous.success) {
      console.error("[before-save-flow] previous record normalization failed", {
        cause: { part: recordType.recordTypeId, reason: "invalid_previous_values" },
        issues: previous.issues.map(({ code, path }) => ({ code, path })),
      });
      return { success: false, reason: "unavailable" };
    }
    previousValues = previous.candidate.candidateValues;
  }

  let result;
  try {
    result = evaluateBeforeSaveFlows({
      flows: execution.ruleSet.flows,
      recordTypeId: recordType.recordTypeId,
      fields: recordType.fields,
      operation: initialCandidate.operation,
      candidateValues: initialCandidate.candidateValues,
      ...(previousValues === undefined ? {} : { previousValues }),
      now: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof BeforeSaveFlowEvaluationError) {
      console.error(`[before-save-rules] flow evaluation unavailable: ${describeFailure(error)}`);
      return { success: false, reason: "unavailable" };
    }
    throw error;
  }

  if (!result.success) {
    return {
      success: false,
      reason: "refused",
      ruleKey: result.refusal.ruleKey,
      code: result.refusal.code,
      message: result.refusal.message,
      cause: result.refusal.cause,
      ...(result.refusal.fieldId === undefined ? {} : { fieldId: result.refusal.fieldId }),
    };
  }

  execution.warnings.push(...result.warnings);
  return {
    success: true,
    candidateValues: initialCandidate.candidateValues,
    requirements: result.requirements,
  };
};
