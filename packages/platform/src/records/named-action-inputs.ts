import type { definitionContractVersion } from "../definition/application-contract-versions";
import type { JsonValue } from "../catalogue/common";
import { organizationAccountIdSchema, timestampSchema } from "../catalogue/identifiers";
import type {
  actionDefinitionSchema,
  recordTypeDefinitionSchema,
} from "../definition/module-contracts";
import { compileTextInputPattern } from "../pages/text-input-pattern";
import { normalizeExactDecimal, parseExactDecimal } from "./exact-decimal";
import {
  currencyCodeSchema,
  dateValueSchema,
  exactDecimalWithinBounds,
  inspectRecordRichText,
  moneyValueSchema,
  recordLinkValueSchema,
  recordRichTextDocumentSchema,
} from "./module-field-values";
import type { TransactionFlowSeed } from "../rules/transaction-flow-run";
import { flowRuntimeValueOf } from "../rules/flow-runtime-value";
import { isRecord } from "../catalogue/runtime-primitives";
import { evaluateTypedCondition } from "../rules/typed-condition";
import { TypedConditionEvaluationError } from "../rules/typed-condition-error";

/**
 * What the record service owns about running a named action as a flow: checking the action's
 * typed inputs against their declarations, deciding its declared precondition, and giving the flow
 * the record and inputs it reads. The flow is run by the flow interpreter and its record steps are
 * planned and applied by the one record writer.
 */

type NamedActionDefinition = ReturnType<typeof actionDefinitionSchema.parse>;
type RecordTypeDefinition = ReturnType<typeof recordTypeDefinitionSchema.parse>;

export type PreparedNamedAction = Readonly<{
  /**
   * The sole current Module validation contract the subject Record's owning Module release was
   * published under. It is checked, never branched on.
   */
  validationContractVersion: typeof definitionContractVersion;
  action: NamedActionDefinition;
  recordType: RecordTypeDefinition;
  recordId: string;
  existingValues: Readonly<Record<string, unknown>>;
  actorOrganizationAccountId: string;
}>;

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

// ─── The action's typed inputs ────────────────────────────────────────────────────────────────

const exactWithin = (
  value: string,
  validation: { minimum?: string | undefined; maximum?: string | undefined } | undefined,
): boolean => {
  const parsed = parseExactDecimal(value);
  if (parsed === undefined) return false;
  return exactDecimalWithinBounds(
    parsed,
    validation?.minimum === undefined ? undefined : parseExactDecimal(validation.minimum),
    validation?.maximum === undefined ? undefined : parseExactDecimal(validation.maximum),
  );
};

const inputValue = (
  input: NamedActionDefinition["inputs"][number],
  candidate: unknown,
): JsonValue | undefined => {
  if (input.type === "text") {
    if (typeof candidate !== "string") return undefined;
    if (
      (input.validation?.minimumLength !== undefined &&
        candidate.length < input.validation.minimumLength) ||
      (input.validation?.maximumLength !== undefined &&
        candidate.length > input.validation.maximumLength)
    )
      return undefined;
    if (
      input.validation?.choices !== undefined &&
      !input.validation.choices.some((choice) => choice.value === candidate)
    )
      return undefined;
    if (input.validation?.pattern !== undefined) {
      const pattern = compileTextInputPattern(input.validation.pattern);
      if (pattern === undefined || !pattern.test(candidate)) return undefined;
    }
    return candidate;
  }
  if (input.type === "formatted_text") {
    const parsed = recordRichTextDocumentSchema.safeParse(candidate);
    if (!parsed.success) return undefined;
    const inspected = inspectRecordRichText(parsed.data);
    if (
      (input.validation?.maximumLength !== undefined &&
        inspected.visibleTextLength > input.validation.maximumLength) ||
      (input.validation?.allowedBlocks !== undefined &&
        [...inspected.usedBlocks].some(
          (block) => !input.validation!.allowedBlocks.includes(block as never),
        ))
    )
      return undefined;
    return parsed.data;
  }
  if (input.type === "whole_number") {
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate)) return undefined;
    return (input.validation?.minimum === undefined || candidate >= input.validation.minimum) &&
      (input.validation?.maximum === undefined || candidate <= input.validation.maximum)
      ? candidate
      : undefined;
  }
  if (input.type === "decimal_number") {
    if (typeof candidate !== "string") return undefined;
    const normalized = normalizeExactDecimal(candidate);
    return normalized !== undefined && exactWithin(normalized, input.validation)
      ? normalized
      : undefined;
  }
  if (input.type === "money") {
    const parsed = moneyValueSchema.safeParse(candidate);
    if (!parsed.success || !currencyCodeSchema.safeParse(parsed.data.currency).success)
      return undefined;
    const validation =
      typeof input.validation?.minimum === "string" || typeof input.validation?.maximum === "string"
        ? {
            ...(typeof input.validation.minimum === "string"
              ? { minimum: input.validation.minimum }
              : {}),
            ...(typeof input.validation.maximum === "string"
              ? { maximum: input.validation.maximum }
              : {}),
          }
        : undefined;
    return exactWithin(parsed.data.amount, validation) ? parsed.data : undefined;
  }
  if (input.type === "yes_no") return typeof candidate === "boolean" ? candidate : undefined;
  if (input.type === "date") {
    const parsed = dateValueSchema.safeParse(candidate);
    if (!parsed.success) return undefined;
    return (input.validation?.earliest === undefined || parsed.data >= input.validation.earliest) &&
      (input.validation?.latest === undefined || parsed.data <= input.validation.latest)
      ? parsed.data
      : undefined;
  }
  if (input.type === "date_time") {
    if (!timestampSchema.safeParse(candidate).success) return undefined;
    const instant = Date.parse(String(candidate));
    return (input.validation?.earliest === undefined ||
      instant >= Date.parse(input.validation.earliest)) &&
      (input.validation?.latest === undefined || instant <= Date.parse(input.validation.latest))
      ? (candidate as string)
      : undefined;
  }
  if (input.type === "organization_account_reference")
    return organizationAccountIdSchema.safeParse(candidate).success
      ? (candidate as string)
      : undefined;
  if (input.type === "record_reference") {
    const parsed = recordLinkValueSchema.safeParse(candidate);
    if (!parsed.success) return undefined;
    return input.recordTypes.some(
      (target) =>
        target.state === "resolved" &&
        target.recordTypeId.toLowerCase() === parsed.data.recordTypeId.toLowerCase(),
    )
      ? parsed.data
      : undefined;
  }
  return undefined;
};

/**
 * Checks the supplied inputs against the action's declarations: only declared keys, every required
 * key present, and each value valid for its type and bounds. `undefined` is an invalid request.
 */
export const normalizeActionInputs = (
  action: NamedActionDefinition,
  supplied: Readonly<Record<string, unknown>>,
): Readonly<Record<string, JsonValue>> | undefined => {
  const declared = new Set(action.inputs.map((input) => input.key));
  if (Object.keys(supplied).some((key) => !declared.has(key))) return undefined;
  const result: Record<string, JsonValue> = {};
  for (const input of action.inputs) {
    if (!hasOwn(supplied, input.key)) {
      if (input.required) return undefined;
      continue;
    }
    const parsed = inputValue(input, supplied[input.key]);
    if (parsed === undefined) return undefined;
    result[input.key] = parsed;
  }
  return result;
};

// ─── The declared precondition ─────────────────────────────────────────────────────────────────

/**
 * Whether the action's declared precondition holds for the subject as it is now and the supplied
 * inputs, by the shared typed condition evaluator. `undefined` when it cannot be decided: an input
 * it compares with is not supplied yet (a preview), or the evaluator refuses the values.
 */
export const actionPreconditionHolds = (
  prepared: PreparedNamedAction,
  normalizedInputs: Readonly<Record<string, JsonValue>>,
): boolean | undefined => {
  const condition = prepared.action.precondition;
  if (condition === undefined) return true;
  const fieldIds = new Set<string>();
  const parameterKeys = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (isRecord(node)) {
      if (node.source === "field" && typeof node.fieldId === "string") fieldIds.add(node.fieldId);
      if (node.source === "parameter" && typeof node.key === "string") parameterKeys.add(node.key);
      Object.values(node).forEach(walk);
    }
  };
  walk(condition);
  if ([...parameterKeys].some((key) => !hasOwn(normalizedInputs, key))) return undefined;
  try {
    return evaluateTypedCondition({
      condition,
      sourceRecordFields: prepared.recordType.fields,
      declaredFieldIds: [...fieldIds],
      parameterDeclarations: [...parameterKeys].map((key) => ({
        key,
        type: prepared.action.inputs.find((input) => input.key === key)!.type as never,
      })),
      fieldValues: Object.fromEntries(
        [...fieldIds].map((fieldId) => [
          fieldId,
          hasOwn(prepared.existingValues, fieldId) ? prepared.existingValues[fieldId] : null,
        ]),
      ),
      parameterValues: Object.fromEntries(
        [...parameterKeys].map((key) => [key, normalizedInputs[key]]),
      ),
    });
  } catch (error) {
    if (!(error instanceof TypedConditionEvaluationError)) throw error;
    return undefined;
  }
};

// ─── What the flow reads ──────────────────────────────────────────────────────────────────────

/**
 * The record and the inputs a named action's flow reads, in the flow's own typed view. The subject
 * record's identity is added by the flow runner under the input the flow declares for it.
 */
export const actionFlowSeed = (
  prepared: PreparedNamedAction,
  normalizedInputs: Readonly<Record<string, JsonValue>>,
  issuedAt: string,
): TransactionFlowSeed => ({
  triggerRecord: Object.fromEntries(
    prepared.recordType.fields.map((field) => [
      field.key,
      flowRuntimeValueOf(
        field.type,
        hasOwn(prepared.existingValues, field.fieldId)
          ? prepared.existingValues[field.fieldId]
          : null,
        field.type === "calculation" || field.type === "total"
          ? field.settings.resultType
          : undefined,
      ),
    ]),
  ),
  inputs: Object.fromEntries(
    prepared.action.inputs
      .filter((input) => hasOwn(normalizedInputs, input.key))
      .map((input) => [input.key, flowRuntimeValueOf(input.type, normalizedInputs[input.key])]),
  ),
  subjectRecordId: prepared.recordId,
  actor: prepared.actorOrganizationAccountId,
  now: issuedAt,
});
