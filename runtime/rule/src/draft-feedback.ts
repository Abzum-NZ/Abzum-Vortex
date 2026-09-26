import type { JsonValue, ModuleFieldV3 } from "@vortex/contracts";
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
 * Located presentation state for one draft field, recomputed in full from the
 * current draft so a form clears any state that no longer applies.
 *
 * - `required`: the published field is required for entry, or a before-save
 *   rule requires it for this draft. Generated fields are filled by Record, so
 *   their static requirement is not an entry requirement.
 * - `disabled`: Record refuses submitted values for generated fields, so they
 *   are never editable in a draft.
 * - `visible`: the published before-save rule contract has no visibility
 *   effect, so rules never hide a field. Page placement visibility and
 *   permissions are applied by the page runtime, not this projection.
 */
export type RuleDraftFeedbackFieldState = Readonly<{
  fieldId: string;
  required: boolean;
  visible: boolean;
  disabled: boolean;
}>;

/**
 * Effect-free feedback for the current draft. `fields` carries the located
 * required/visible/disabled state for each subject field, `requirements` carries
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

/** Only plain JSON objects fingerprint; a Map, Date or class instance is refused. */
const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** Field types Record generates itself and refuses as submitted input (`generated_field_input`). */
const generatedFieldTypes = new Set<ModuleFieldV3["type"]>([
  "reference_number",
  "calculation",
  "total",
]);

/** Locale-independent canonical JSON with recursively sorted object keys. */
const canonicalize = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) refuse("input_refused");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isPlainRecord(value)) {
    const entries = Object.entries(value);
    entries.sort(([left], [right]) => codePointCompare(left, right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
      .join(",")}}`;
  }
  return refuse("input_refused");
};

const trustedContext = (value: unknown): RuleDraftFeedbackTrustedContext =>
  isPlainRecord(value) ? (value as RuleDraftFeedbackTrustedContext) : refuse("context_refused");

/**
 * Canonical input/context token for one draft evaluation. It binds the exact
 * release identity (organisation, Module root, revision, version and content),
 * so equal values under another organisation or release never match. Two calls
 * with the same release, draft values, previous values, rule inputs and trusted
 * context always produce the same token; any change produces a different one.
 * The token is exact canonical data, not a hash, so it can never collide; it
 * carries draft values and must not be logged or persisted.
 */
export const ruleDraftFeedbackFingerprint = (input: RuleDraftFeedbackProjectionInput): string => {
  if (input.operation !== "create" && input.operation !== "update") refuse("input_refused");
  if (input.operation === "create" && Object.prototype.hasOwnProperty.call(input, "previousValues"))
    refuse("input_refused");
  const canonical = canonicalize({
    fingerprintVersion: ruleDraftFeedbackFingerprintVersion,
    subjectRecordTypeId: input.subjectRecordTypeId,
    operation: input.operation,
    organizationId: input.release.organizationId,
    moduleRootId: input.release.rootId,
    releaseRevision: input.release.releaseRevision,
    releaseVersion: input.release.releaseVersion,
    contentFingerprint: input.release.contentFingerprint,
    resolutionFingerprint: input.release.resolutionFingerprint,
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
  const ruleRequiredFieldIds = new Set(requirements.map((requirement) => requirement.fieldId));

  // The evaluator has already refused an unknown subject record type.
  const recordType = input.release.content.recordTypes.find(
    (entry) => entry.recordTypeId === input.subjectRecordTypeId,
  )!;
  // Publication rejects a requirement on a field outside the subject, so every
  // requirement is located on one of these fields.
  const fields = recordType.fields
    .map((field): RuleDraftFeedbackFieldState => {
      const generated = generatedFieldTypes.has(field.type);
      return {
        fieldId: field.fieldId,
        required: ruleRequiredFieldIds.has(field.fieldId) || (field.required && !generated),
        visible: true,
        disabled: generated,
      };
    })
    .sort((left, right) => codePointCompare(left.fieldId, right.fieldId));

  return {
    fingerprint,
    fields,
    requirements,
    warnings: result.warnings,
    refusal: result.success ? undefined : result.refusal,
  };
};
