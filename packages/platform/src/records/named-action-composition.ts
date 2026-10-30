import { jsonValueSchema, type JsonValue } from "../catalogue/common";
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
import type { TransactionFlowOutcome, TransactionFlowSeed } from "../rules/transaction-flow-run";
import { flowRuntimeValueOf } from "../rules/flow-runtime-value";
import type { FlowProtectedTaskCall } from "../rules/flow-interpreter";
import { isRecord } from "../catalogue/runtime-primitives";
import { evaluateTypedCondition } from "../rules/typed-condition";
import { TypedConditionEvaluationError } from "../rules/typed-condition-error";

/**
 * What the record service owns about running a named action as a flow: checking the action's
 * typed inputs against their declarations, deciding its declared precondition, giving the flow the
 * record and inputs it reads, and turning the record steps the flow collected into the one
 * mutation list `apply_record_changes` applies. The flow itself is run by the flow interpreter.
 *
 * The database checks every write against the write policy derived from the installed flow, so
 * what is composed here is a verified statement of intent, never an authority the database trusts.
 */

type NamedActionDefinition = ReturnType<typeof actionDefinitionSchema.parse>;
type RecordTypeDefinition = ReturnType<typeof recordTypeDefinitionSchema.parse>;

/**
 * One `create_record` target resolved by the database from the published resolved record-type
 * reference. The runtime never looks a target up itself.
 */
export type NamedActionCreateTarget = Readonly<{
  ordinal: number;
  recordTypeId: string;
  recordType: RecordTypeDefinition;
  beforeSaveFlows: unknown;
}>;

export type PreparedNamedAction = Readonly<{
  /**
   * The sole current Module validation contract the subject Record's owning Module release was
   * published under. It is checked, never branched on.
   */
  validationContractVersion: "4.1.0";
  action: NamedActionDefinition;
  recordType: RecordTypeDefinition;
  recordId: string;
  existingValues: Readonly<Record<string, unknown>>;
  actorOrganizationAccountId: string;
  createTargets: readonly NamedActionCreateTarget[];
  /**
   * The subject fields the actor may currently read under the named action. A `record.changes`
   * task only copies relationships whose link field is in this set.
   */
  readableFieldIds?: ReadonlySet<string>;
}>;

/** One composed creation, in authored task order. */
export type NamedActionCreation = Readonly<{
  ordinal: number;
  recordTypeId: string;
  values: Readonly<Record<string, JsonValue | null>>;
}>;

/**
 * One `copy_relationships` change, resolved. The database re-derives the same plan from the
 * installed action and the supplied inputs, so this is a verified statement of intent that the
 * preview and the final preparation must agree on.
 */
export type NamedActionRelationshipCopy = Readonly<{
  ordinal: number;
  targetRecordTypeId: string;
  targetRecordId: string;
  relationshipIds: readonly string[];
}>;

export type NamedActionComposition = Readonly<{
  submittedValues: Readonly<Record<string, JsonValue | null>>;
  creations: readonly NamedActionCreation[];
  relationshipCopies: readonly NamedActionRelationshipCopy[];
  /**
   * Whether the action soft-deletes its subject. The delete itself is never composed here: it runs
   * through the shared protected lifecycle delete after the action's own tasks.
   */
  softDeletesSubject: boolean;
  announcedEventKeys: readonly string[];
  normalizedInputs: Readonly<Record<string, JsonValue>>;
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

// ─── What the flow asked for ──────────────────────────────────────────────────────────────────

const textProperty = (call: FlowProtectedTaskCall, property: string): string | undefined => {
  const carried = call.properties[property]?.value;
  return typeof carried === "string" ? carried : undefined;
};

/** The field-id keyed map of evaluated values a record step carries, or undefined. */
const valueMap = (
  call: FlowProtectedTaskCall,
  property: string,
): Readonly<Record<string, unknown>> | undefined => {
  const carried = call.properties[property]?.value;
  return isRecord(carried) ? carried : undefined;
};

/** Names a record type's fields by key or by permanent identity, as a record step writes them. */
const writtenFields = (
  fields: RecordTypeDefinition["fields"],
  values: Readonly<Record<string, unknown>>,
): Record<string, JsonValue> | undefined => {
  const byName = new Map<string, string>();
  for (const field of fields) {
    byName.set(field.key.toLowerCase(), field.fieldId);
    byName.set(field.fieldId.toLowerCase(), field.fieldId);
  }
  const written: Record<string, JsonValue> = {};
  for (const [name, value] of Object.entries(values)) {
    const fieldId = byName.get(name.toLowerCase());
    if (
      fieldId === undefined ||
      hasOwn(written, fieldId) ||
      !jsonValueSchema.safeParse(value).success
    )
      return undefined;
    written[fieldId] = value as JsonValue;
  }
  return written;
};

/**
 * Resolves one authored relationship copy against the subject. The target is read through the
 * action's `record_reference` input, which must name another record of the subject's own record
 * type: the copied relationships are the subject's, so only a same-type record can hold them. Every
 * selected id must be a `many_to_one` relationship the subject declares (a `one_to_one` link cannot
 * be held by a second record), whose link field the actor can currently read and that no earlier
 * `record.set_fields` task changes: the database copies the subject's edge as it stands before the
 * command writes the subject. Nothing is copied that the action did not name.
 */
const relationshipCopy = (
  prepared: PreparedNamedAction,
  normalizedInputs: Readonly<Record<string, JsonValue>>,
  ordinal: number,
  authored: Readonly<{ targetInputKey: string; relationshipIds: readonly string[] }>,
  setFieldIds: ReadonlySet<string>,
): NamedActionRelationshipCopy | undefined => {
  if (!hasOwn(normalizedInputs, authored.targetInputKey)) return undefined;
  const target = recordLinkValueSchema.safeParse(normalizedInputs[authored.targetInputKey]);
  if (
    !target.success ||
    target.data.recordTypeId.toLowerCase() !== prepared.recordType.recordTypeId.toLowerCase() ||
    target.data.recordId.toLowerCase() === prepared.recordId.toLowerCase()
  )
    return undefined;
  const relationships = new Map(
    prepared.recordType.relationships.map((relationship) => [
      relationship.relationshipId.toLowerCase(),
      relationship,
    ]),
  );
  const readable = new Set(
    [...(prepared.readableFieldIds ?? [])].map((fieldId) => fieldId.toLowerCase()),
  );
  const selected = new Set<string>();
  for (const relationshipId of authored.relationshipIds) {
    const key = relationshipId.toLowerCase();
    // A repeated id names the same relationship; the database copies it once.
    if (selected.has(key)) continue;
    const relationship = relationships.get(key);
    if (
      relationship === undefined ||
      relationship.fromRecordTypeId.toLowerCase() !==
        prepared.recordType.recordTypeId.toLowerCase() ||
      relationship.cardinality !== "many_to_one" ||
      !readable.has(relationship.fromFieldId.toLowerCase()) ||
      setFieldIds.has(relationship.fromFieldId.toLowerCase())
    )
      return undefined;
    selected.add(key);
  }
  return {
    ordinal,
    targetRecordTypeId: target.data.recordTypeId,
    targetRecordId: target.data.recordId,
    relationshipIds: [...selected],
  };
};

/**
 * Turns the record steps an action's flow collected into the composition `apply_record_changes`
 * applies. The database checks every part of it against the write policy derived from the same
 * flow, so this is a verified statement of intent, never an authority.
 */
export const composeFlowEffects = (
  prepared: PreparedNamedAction,
  normalizedInputs: Readonly<Record<string, JsonValue>>,
  collected: Extract<TransactionFlowOutcome, { kind: "collected" }>,
): NamedActionComposition | undefined => {
  const targets = new Map(prepared.createTargets.map((target) => [target.ordinal, target]));
  const submittedValues: Record<string, JsonValue | null> = {};
  const creations: NamedActionCreation[] = [];
  const relationshipCopies: NamedActionRelationshipCopy[] = [];
  const authoredCopies: { targetInputKey: string; relationshipIds: string[] }[] = [];
  const setFieldIds = new Set<string>();
  let softDeletesSubject = false;
  const announcedEventKeys: string[] = [];

  for (const call of collected.calls) {
    if (call.taskType === "event.announce") {
      const key = textProperty(call, "event");
      if (key === undefined) return undefined;
      announcedEventKeys.push(key);
      continue;
    }
    if (call.taskType === "record.create") {
      const ordinal = creations.length;
      const target = targets.get(ordinal);
      const authored = valueMap(call, "values");
      if (
        target === undefined ||
        authored === undefined ||
        textProperty(call, "record_type")?.toLowerCase() !== target.recordTypeId.toLowerCase()
      )
        return undefined;
      const values = writtenFields(target.recordType.fields, authored);
      if (values === undefined) return undefined;
      creations.push({ ordinal, recordTypeId: target.recordTypeId, values });
      continue;
    }
    if (call.taskType === "record.changes") {
      const changes = call.properties.changes?.value;
      if (!Array.isArray(changes)) return undefined;
      for (const change of changes) {
        const target = isRecord(change) && isRecord(change.target) ? change.target : undefined;
        const reference =
          target !== undefined && isRecord(target.reference) ? target.reference : undefined;
        if (
          !isRecord(change) ||
          change.kind !== "copy_relationships" ||
          !Array.isArray(change.relationshipIds) ||
          reference === undefined ||
          reference.source !== "input" ||
          typeof reference.name !== "string"
        )
          return undefined;
        authoredCopies.push({
          targetInputKey: reference.name,
          relationshipIds: change.relationshipIds.filter(
            (item): item is string => typeof item === "string",
          ),
        });
      }
      continue;
    }
    if (call.taskType === "record.delete") {
      const record = call.properties.record?.value;
      // One delete per action; a second could only name the same subject.
      if (
        softDeletesSubject ||
        textProperty(call, "record_type")?.toLowerCase() !==
          prepared.recordType.recordTypeId.toLowerCase() ||
        (typeof record === "string" ? record : undefined) !== prepared.recordId
      )
        return undefined;
      softDeletesSubject = true;
      continue;
    }
    if (call.taskType !== "record.set_fields") return undefined;
    const authored = valueMap(call, "values");
    const values =
      authored === undefined ? undefined : writtenFields(prepared.recordType.fields, authored);
    if (values === undefined) return undefined;
    for (const [fieldId, value] of Object.entries(values)) {
      setFieldIds.add(fieldId.toLowerCase());
      submittedValues[fieldId] = value;
    }
  }
  // A copy reads the subject's edge as it stands before the command writes the subject, so no
  // field the flow sets may be one of the copied links.
  for (const authored of authoredCopies) {
    const copy = relationshipCopy(
      prepared,
      normalizedInputs,
      relationshipCopies.length,
      authored,
      setFieldIds,
    );
    if (copy === undefined) return undefined;
    relationshipCopies.push(copy);
  }
  if (creations.length !== prepared.createTargets.length) return undefined;
  // The delete runs against the subject revision the command names, so a deleting action may only
  // copy relationships (which write the target, never the subject) and announce Events. A subject
  // write or a creation can move that revision, so publication and this composition refuse the
  // combination.
  if (softDeletesSubject && (setFieldIds.size > 0 || creations.length > 0)) return undefined;
  return {
    submittedValues,
    creations,
    relationshipCopies,
    softDeletesSubject,
    announcedEventKeys,
    normalizedInputs,
  };
};
