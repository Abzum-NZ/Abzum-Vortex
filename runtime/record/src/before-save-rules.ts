import "server-only";

import {
  ruleGraphSchema,
  type JsonValue,
  type ModuleDefinitionConsumerReadResultV3,
  type RecordTypeDefinitionV3,
  type RuleGraph,
} from "@vortex/contracts";
import {
  BeforeSaveRuleGraphEvaluationError,
  evaluateBeforeSaveRuleGraphs,
  type BeforeSaveRuleRequirement,
  type BeforeSaveRuleWarning,
} from "@vortex/rule";
import {
  prepareInitialRecordFieldCandidateV2,
  type InitialRecordFieldCandidateV2,
} from "./field-values";

/** Code of the correction issue a deliberate rule refusal raises (located on a field when it names one). */
export const beforeSaveRuleRefusedIssueCode = "before_save_rule_refused";
/** Code of the issue raised when rules could not be reached or evaluated; the save is refused, never skipped. */
export const beforeSaveRuleUnavailableIssueCode = "before_save_rule_unavailable";

/**
 * The compiled before-save graphs of one exact Module release whose subject is
 * the saved record type. The database preparation reads them from the same
 * immutable release row the save already resolved, so no caller input can
 * supply or replace them.
 */
export type BeforeSaveRuleSet = Readonly<{
  moduleRootId: string;
  releaseRevision: number;
  rules: readonly RuleGraph[];
}>;

/**
 * Per-attempt rule execution. `warnings` is filled by the single evaluation of
 * that attempt so the caller can carry them to the save outcome.
 */
export type BeforeSaveRuleExecution = Readonly<{
  ruleSet: BeforeSaveRuleSet;
  warnings: BeforeSaveRuleWarning[];
}>;

export const beginBeforeSaveRuleExecution = (ruleSet: BeforeSaveRuleSet): BeforeSaveRuleExecution => ({
  ruleSet,
  warnings: [],
});

export type BeforeSaveRuleApplication =
  | Readonly<{
      success: true;
      candidateValues: Readonly<Record<string, JsonValue>>;
      requirements: readonly BeforeSaveRuleRequirement[];
    }>
  | Readonly<{ success: false; reason: "refused"; fieldId?: string }>
  | Readonly<{ success: false; reason: "unavailable" }>;

const generatedFieldTypes = new Set<string>(["reference_number", "calculation", "total"]);

/**
 * Parses the `beforeSaveRules` a preparation returned. Anything that is not the
 * exact closed shape for this record type — including a rule that is not a
 * compiled graph, such as a legacy rule definition — is unreachable and yields
 * `undefined`; the caller must then refuse the save rather than run it without
 * its rules.
 */
export const parseBeforeSaveRuleSet = (
  candidate: unknown,
  recordTypeId: string,
): BeforeSaveRuleSet | undefined => {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate))
    return undefined;
  const value = candidate as Record<string, unknown>;
  if (
    typeof value.moduleRootId !== "string" ||
    typeof value.releaseRevision !== "number" ||
    !Number.isSafeInteger(value.releaseRevision) ||
    !Array.isArray(value.rules)
  )
    return undefined;
  const rules: RuleGraph[] = [];
  for (const entry of value.rules) {
    const parsed = ruleGraphSchema.safeParse(entry);
    // A graph for another subject would be silently skipped by the evaluator.
    if (!parsed.success || parsed.data.subjectRecordTypeId !== recordTypeId) return undefined;
    rules.push(parsed.data);
  }
  return { moduleRootId: value.moduleRootId, releaseRevision: value.releaseRevision, rules };
};

/**
 * Runs every applicable compiled rule once against one save attempt's initial
 * candidate and returns the candidate with the rules' field effects applied,
 * plus the requirements the final field policy must satisfy. Effects on
 * generated fields are refused: only their owning engine may produce them.
 */
export const applyBeforeSaveRules = (input: {
  execution: BeforeSaveRuleExecution;
  recordType: RecordTypeDefinitionV3;
  initialCandidate: InitialRecordFieldCandidateV2;
  organizationCurrency?: string;
}): BeforeSaveRuleApplication => {
  const { execution, recordType, initialCandidate } = input;
  execution.warnings.length = 0;
  if (execution.ruleSet.rules.length === 0)
    return { success: true, candidateValues: initialCandidate.candidateValues, requirements: [] };

  let previousValues: Readonly<Record<string, JsonValue>> | undefined;
  if (initialCandidate.operation === "update") {
    // The stored values normalized exactly as the candidate's own existing values are.
    const previous = prepareInitialRecordFieldCandidateV2({
      operation: "update",
      recordType,
      submittedValues: {},
      existingValues: initialCandidate.originalValues,
      ...(input.organizationCurrency === undefined
        ? {}
        : { organizationCurrency: input.organizationCurrency }),
    });
    if (!previous.success) return { success: false, reason: "unavailable" };
    previousValues = previous.candidate.candidateValues;
  }

  // The evaluator reads only the release's rule graphs and record types. The
  // record type is the trusted one the save resolved from the same release.
  const release = {
    kind: "module",
    rootId: execution.ruleSet.moduleRootId,
    releaseRevision: execution.ruleSet.releaseRevision,
    content: { recordTypes: [recordType], rules: execution.ruleSet.rules },
  } as unknown as ModuleDefinitionConsumerReadResultV3;

  let result;
  try {
    const base = {
      release,
      subjectRecordTypeId: recordType.recordTypeId,
      initialCandidateValues: initialCandidate.candidateValues,
    };
    result =
      previousValues === undefined
        ? evaluateBeforeSaveRuleGraphs({ ...base, operation: "create" })
        : evaluateBeforeSaveRuleGraphs({ ...base, operation: "update", previousValues });
  } catch (error) {
    if (error instanceof BeforeSaveRuleGraphEvaluationError)
      return { success: false, reason: "unavailable" };
    throw error;
  }

  if (!result.success) {
    return {
      success: false,
      reason: "refused",
      ...(result.refusal.fieldId === undefined ? {} : { fieldId: result.refusal.fieldId }),
    };
  }

  const generatedFieldIds = new Set<string>(
    recordType.fields.filter((field) => generatedFieldTypes.has(field.type)).map((f) => f.fieldId),
  );
  const changedFieldIds = [...Object.keys(result.setValues), ...result.clearFieldIds];
  if (changedFieldIds.some((fieldId) => generatedFieldIds.has(fieldId)))
    return { success: false, reason: "unavailable" };

  const candidateValues: Record<string, JsonValue> = {
    ...initialCandidate.candidateValues,
    ...result.setValues,
  };
  for (const fieldId of result.clearFieldIds) delete candidateValues[fieldId];
  execution.warnings.push(...result.warnings);
  return { success: true, candidateValues, requirements: result.requirements };
};
