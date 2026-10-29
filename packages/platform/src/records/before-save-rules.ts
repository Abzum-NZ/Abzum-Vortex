import "server-only";
import { z } from "zod";

import type { JsonValue } from "../catalogue/common";
import { describeFailure, isRecord } from "../catalogue/runtime-primitives";
import type { RecordTypeDefinition } from "../definition/module-contracts";
import {
  flowSchema,
  type FlowBeforeSaveOperation,
  type FlowDefinition,
} from "../workflows/flow-contracts";
import { compileFlowPlans, FlowPlanError } from "../workflows/flow-plan";
import {
  BeforeSaveFlowEvaluationError,
  evaluateBeforeSaveFlows,
  type BeforeSaveRuleRequirement,
  type BeforeSaveRuleWarning,
} from "../rules/before-save-flow-run";
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
 * The exact closed shape of the `beforeSaveFlows` a preparation returns. Anything else, including
 * a flow that is not a compiled BeforeSave flow of the saved record type, is unreachable: the
 * caller refuses the save rather than run it without its flows.
 */
const beforeSaveFlowSetSchema = z
  .object({
    moduleRootId: z.uuid(),
    releaseRevision: z.number().int().positive().safe(),
    flows: z.array(flowSchema),
  })
  .strict();

/**
 * The BeforeSave flows of one immutable Module release for one record type, compiled once: the
 * preparation reads them from the release row the save resolved, and a release row never changes,
 * so (Module root, release revision, record type) names one flow set forever. A new release
 * revision is a new key; nothing is replaced in place. The cache is bounded; the oldest entry
 * leaves first.
 */
const beforeSaveFlowSetLimit = 1_000;
const beforeSaveFlowSets = new Map<string, BeforeSaveFlowSet>();

const compileBeforeSaveFlowSet = (
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
  try {
    const { plans } = compileFlowPlans(parsed.data.flows);
    return {
      ...parsed.data,
      flows: parsed.data.flows.map((flow) => plans.get(String(flow.id))!.definition),
    };
  } catch (error) {
    if (!(error instanceof FlowPlanError)) throw error;
    console.error("[before-save-flow] flow cannot be planned", {
      cause: { part: error.flowId, reason: error.reason },
    });
    return undefined;
  }
};

/** The compiled BeforeSave flow set a preparation names; `undefined` refuses the save. */
export const beforeSaveFlowSetOf = (
  candidate: unknown,
  recordTypeId: string,
): BeforeSaveFlowSet | undefined => {
  const header = candidate as Partial<
    Record<"moduleRootId" | "releaseRevision" | "flows", unknown>
  >;
  const key =
    isRecord(candidate) &&
    typeof header.moduleRootId === "string" &&
    Number.isSafeInteger(header.releaseRevision) &&
    Array.isArray(header.flows)
      ? JSON.stringify([
          header.moduleRootId.toLowerCase(),
          header.releaseRevision,
          recordTypeId.toLowerCase(),
        ])
      : undefined;
  const known = key === undefined ? undefined : beforeSaveFlowSets.get(key);
  if (known !== undefined && known.flows.length === (header.flows as unknown[]).length) {
    beforeSaveFlowSets.delete(key!);
    beforeSaveFlowSets.set(key!, known);
    return known;
  }
  const compiled = compileBeforeSaveFlowSet(candidate, recordTypeId);
  if (compiled === undefined || key === undefined) return compiled;
  beforeSaveFlowSets.set(key, compiled);
  if (beforeSaveFlowSets.size > beforeSaveFlowSetLimit)
    beforeSaveFlowSets.delete(beforeSaveFlowSets.keys().next().value!);
  return compiled;
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

  return evaluateRuleExecution({
    execution,
    recordType,
    operation: initialCandidate.operation,
    candidateValues: initialCandidate.candidateValues,
    ...(previousValues === undefined ? {} : { previousValues }),
  });
};

/** Lifecycle rules inspect the stored values without producing a field mutation. */
export const applyBeforeSaveLifecycleRules = (input: {
  execution: BeforeSaveRuleExecution;
  recordType: RecordTypeDefinition;
  operation: "delete" | "restore";
  existingValues: Readonly<Record<string, unknown>>;
  organizationCurrency?: string;
}): BeforeSaveRuleApplication => {
  const prepared = prepareInitialRecordFieldCandidate({
    operation: "update",
    recordType: input.recordType,
    submittedValues: {},
    existingValues: input.existingValues,
    ...(input.organizationCurrency === undefined
      ? {}
      : { organizationCurrency: input.organizationCurrency }),
  });
  if (!prepared.success) {
    console.error("[before-save-flow] lifecycle record normalization failed", {
      cause: { part: input.recordType.recordTypeId, reason: "invalid_stored_values" },
      issues: prepared.issues.map(({ code, path }) => ({ code, path })),
    });
    return { success: false, reason: "unavailable" };
  }
  return evaluateRuleExecution({
    execution: input.execution,
    recordType: input.recordType,
    operation: input.operation,
    candidateValues: prepared.candidate.candidateValues,
    previousValues: prepared.candidate.candidateValues,
  });
};

const evaluateRuleExecution = (input: {
  execution: BeforeSaveRuleExecution;
  recordType: RecordTypeDefinition;
  operation: FlowBeforeSaveOperation;
  candidateValues: Readonly<Record<string, JsonValue>>;
  previousValues?: Readonly<Record<string, JsonValue>>;
}): BeforeSaveRuleApplication => {
  const { execution, recordType, previousValues } = input;
  execution.warnings.length = 0;
  let result;
  try {
    result = evaluateBeforeSaveFlows({
      flows: execution.ruleSet.flows,
      recordTypeId: recordType.recordTypeId,
      fields: recordType.fields,
      operation: input.operation,
      candidateValues: input.candidateValues,
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
    candidateValues: input.candidateValues,
    requirements: result.requirements,
  };
};
