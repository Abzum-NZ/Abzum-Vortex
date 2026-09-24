import type { JsonValue } from "@vortex/contracts";
import {
  evaluateBeforeSaveRuleGraphs,
  type BeforeSaveRuleRefusal,
  type BeforeSaveRuleRequirement,
  type BeforeSaveRuleWarning,
  type EvaluateBeforeSaveRuleGraphsInput,
} from "./before-save-rule-graphs";
import { codePointCompare } from "./typed-condition-core";

/**
 * Version marker for the draft-feedback input/context token. Bump it when the
 * fingerprinted input set changes so a form can never mistake an old projection
 * for a current one.
 */
export const ruleDraftFeedbackFingerprintVersion = "v1" as const;

/**
 * Trusted caller context (actor, organisation, installation, release, form
 * context). It is only folded into the fingerprint so a changed context
 * discards stale feedback. This adapter never reads it as authority and never
 * elevates identity.
 */
export type RuleDraftFeedbackTrustedContext = Readonly<Record<string, JsonValue>>;

/**
 * The exact inputs a form supplies for one draft evaluation: the compiled
 * release rules, the current and previous draft values, any declared rule
 * inputs and the trusted context.
 */
export type RuleDraftFeedbackProjectionInput = EvaluateBeforeSaveRuleGraphsInput &
  Readonly<{ trustedContext: RuleDraftFeedbackTrustedContext }>;

/**
 * Located presentation state for one draft field. The before-save profile
 * currently declares no visibility or disable nodes, so a field with no rule
 * effect stays visible and enabled. The projection recomputes every field from
 * the current draft, so a form clears any state that no longer applies.
 */
export type RuleDraftFeedbackFieldState = Readonly<{
  fieldId: string;
  required: boolean;
  visible: boolean;
  enabled: boolean;
}>;

/**
 * Effect-free feedback for the current draft. `fields` carries the located
 * required/visible/enabled state for each subject field, `requirements` carries
 * the located requirement messages, and `refusal` carries a located refusal
 * when a rule refuses the draft. Warning nodes carry no field in the current
 * contract, so warnings are form-level. The projection never persists, mutates,
 * emits an event, or requests an operation or workflow.
 */
export type RuleDraftFeedbackProjection = Readonly<{
  fingerprint: string;
  fields: readonly RuleDraftFeedbackFieldState[];
  requirements: readonly BeforeSaveRuleRequirement[];
  warnings: readonly BeforeSaveRuleWarning[];
  refusal: BeforeSaveRuleRefusal | undefined;
}>;

export type RuleDraftFeedbackProjectionErrorReason = "input_refused" | "context_refused";

export class RuleDraftFeedbackProjectionError extends Error {
  constructor(readonly reason: RuleDraftFeedbackProjectionErrorReason) {
    super(`vortex.rule.draft_feedback_${reason}`);
    this.name = "RuleDraftFeedbackProjectionError";
  }
}

const refuse = (reason: RuleDraftFeedbackProjectionErrorReason): never => {
  throw new RuleDraftFeedbackProjectionError(reason);
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Locale-independent canonical JSON with recursively sorted object keys. */
const canonicalize = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) refuse("input_refused");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value);
    entries.sort(([left], [right]) => codePointCompare(left, right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
      .join(",")}}`;
  }
  return refuse("input_refused");
};

const trustedContext = (value: unknown): RuleDraftFeedbackTrustedContext =>
  isRecord(value) ? (value as RuleDraftFeedbackTrustedContext) : refuse("context_refused");

/**
 * Canonical input/context token for one draft evaluation. Two calls with the
 * same draft values, previous values, rule inputs and trusted context always
 * produce the same token; any change produces a different one.
 */
export const ruleDraftFeedbackFingerprint = (input: RuleDraftFeedbackProjectionInput): string => {
  if (input.operation !== "create" && input.operation !== "update") refuse("input_refused");
  if (input.operation === "create" && Object.prototype.hasOwnProperty.call(input, "previousValues"))
    refuse("input_refused");
  const canonical = canonicalize({
    fingerprintVersion: ruleDraftFeedbackFingerprintVersion,
    subjectRecordTypeId: input.subjectRecordTypeId,
    operation: input.operation,
    releaseRevision: input.release.releaseRevision,
    contentFingerprint: input.release.contentFingerprint,
    initialCandidateValues: input.initialCandidateValues,
    previousValues: input.operation === "update" ? input.previousValues : null,
    inputValuesByRuleId: input.inputValuesByRuleId ?? {},
    trustedContext: trustedContext(input.trustedContext),
  });
  return `${ruleDraftFeedbackFingerprintVersion}:${canonical}`;
};

/**
 * A projection is only valid for the exact draft it was computed from. Pass the
 * fingerprint of the current draft and discard the result when it differs.
 */
export const isRuleDraftFeedbackApplicable = (
  projection: RuleDraftFeedbackProjection,
  currentFingerprint: string,
): boolean => projection.fingerprint === currentFingerprint;

/**
 * Evaluates the compiled before-save rules purely and projects their effect on
 * the current draft into located field feedback and messages.
 */
export const projectRuleDraftFeedback = (
  input: RuleDraftFeedbackProjectionInput,
): RuleDraftFeedbackProjection => {
  const fingerprint = ruleDraftFeedbackFingerprint(input);
  const result = evaluateBeforeSaveRuleGraphs(input);
  const requirements = result.success ? result.requirements : [];

  const fieldsById = new Map<string, RuleDraftFeedbackFieldState>();
  const recordType = input.release.content.recordTypes.find(
    (entry) => entry.recordTypeId === input.subjectRecordTypeId,
  );
  for (const field of recordType?.fields ?? [])
    fieldsById.set(field.fieldId, {
      fieldId: field.fieldId,
      required: false,
      visible: true,
      enabled: true,
    });
  for (const requirement of requirements) {
    const current = fieldsById.get(requirement.fieldId);
    fieldsById.set(requirement.fieldId, {
      fieldId: requirement.fieldId,
      required: true,
      visible: current?.visible ?? true,
      enabled: current?.enabled ?? true,
    });
  }
  const fields = [...fieldsById.values()].sort((left, right) =>
    codePointCompare(left.fieldId, right.fieldId),
  );

  return {
    fingerprint,
    fields,
    requirements,
    warnings: result.warnings,
    refusal: result.success ? undefined : result.refusal,
  };
};
