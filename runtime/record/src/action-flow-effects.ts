import {
  type actionDefinitionV2Schema,
  compileTextInputPattern,
  currencyCodeV2Schema,
  dateValueV2Schema,
  exactDecimalWithinBoundsV2,
  inspectRecordRichTextV2,
  jsonValueSchema,
  moneyValueV2Schema,
  normalizeExactDecimal,
  organizationAccountIdSchema,
  parseExactDecimal,
  recordLinkValueV2Schema,
  type recordTypeDefinitionV2Schema,
  recordRichTextDocumentV2Schema,
  timestampSchema,
  type JsonValue,
} from "@vortex/contracts";
import type {
  ActionFlowOutcome,
  ActionFlowSeed,
  FlowProtectedTaskCall,
  FlowRuntimeValue,
} from "@vortex/rule";

/**
 * What the record service owns about running a named action as a flow (#1063): checking the action's
 * typed inputs against their declarations, giving the flow the record and inputs it reads, and
 * turning the record tasks the flow collected into the one mutation list `apply_record_changes`
 * applies. The flow itself is run by the flow interpreter; nothing here decides a precondition.
 *
 * The database re-derives every effect from the installed action and its inputs, so what is composed
 * here is a verified statement of intent, never an authority the database trusts.
 */

type NamedActionDefinition = ReturnType<typeof actionDefinitionV2Schema.parse>;
type RecordTypeDefinition = ReturnType<typeof recordTypeDefinitionV2Schema.parse>;

/**
 * One `create_record` target resolved by the database from the published resolved record-type
 * reference. The runtime never looks a target up itself.
 */
export type NamedActionCreateTarget = Readonly<{
  ordinal: number;
  recordTypeId: string;
  recordType: RecordTypeDefinition;
}>;

export type PreparedNamedAction = Readonly<{
  /**
   * The sole current Module validation contract the subject Record's owning Module release was
   * published under. It is checked, never branched on.
   */
  validationContractVersion: "3.0.0";
  action: NamedActionDefinition;
  recordType: RecordTypeDefinition;
  recordId: string;
  existingValues: Readonly<Record<string, unknown>>;
  actorOrganizationAccountId: string;
  createTargets: readonly NamedActionCreateTarget[];
  /**
   * The subject fields the actor may currently read under the named action. A `copy_relationships`
   * effect only copies relationships whose link field is in this set.
   */
  readableFieldIds?: ReadonlySet<string>;
}>;

/** One composed creation, in authored effect order. */
export type NamedActionCreation = Readonly<{
  ordinal: number;
  recordTypeId: string;
  values: Readonly<Record<string, JsonValue | null>>;
}>;

/**
 * One `copy_relationships` effect, resolved. The database re-derives the same plan from the
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
   * through the shared protected lifecycle delete after the action's own effects.
   */
  softDeletesSubject: boolean;
  announcedEventKeys: readonly string[];
  normalizedInputs: Readonly<Record<string, JsonValue>>;
}>;

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ─── The action's typed inputs ────────────────────────────────────────────────────────────────

const exactWithin = (
  value: string,
  validation: { minimum?: string | undefined; maximum?: string | undefined } | undefined,
): boolean => {
  const parsed = parseExactDecimal(value);
  if (parsed === undefined) return false;
  return exactDecimalWithinBoundsV2(
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
    if (input.validation?.pattern !== undefined) {
      const pattern = compileTextInputPattern(input.validation.pattern);
      if (pattern === undefined || !pattern.test(candidate)) return undefined;
    }
    return candidate;
  }
  if (input.type === "formatted_text") {
    const parsed = recordRichTextDocumentV2Schema.safeParse(candidate);
    if (!parsed.success) return undefined;
    const inspected = inspectRecordRichTextV2(parsed.data);
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
  if (input.type === "number") {
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) return undefined;
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
    const parsed = moneyValueV2Schema.safeParse(candidate);
    if (!parsed.success || !currencyCodeV2Schema.safeParse(parsed.data.currency).success)
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
  if (input.type === "boolean") return typeof candidate === "boolean" ? candidate : undefined;
  if (input.type === "date") {
    const parsed = dateValueV2Schema.safeParse(candidate);
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
    const parsed = recordLinkValueV2Schema.safeParse(candidate);
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

// ─── What the flow reads ──────────────────────────────────────────────────────────────────────

const typedValue = (type: string, value: JsonValue | null): FlowRuntimeValue => ({
  type,
  value: value as JsonValue,
});

/**
 * The flow's own view of a stored field value or an action input, typed the way the flow evaluator
 * compares it: money by its amount, a link by the record it names, a person by the account. A value
 * that does not have the shape its type needs is a `json` value, which no comparison accepts, so a
 * precondition that reads it refuses the run instead of computing something it did not say.
 */
const flowRuntimeValue = (type: string, value: unknown): FlowRuntimeValue => {
  const mapped = (flowType: string, accept: (candidate: unknown) => JsonValue | undefined) => {
    if (value === null || value === undefined) return typedValue(flowType, null);
    const accepted = accept(value);
    return accepted === undefined
      ? typedValue("json", jsonValueSchema.safeParse(value).success ? (value as JsonValue) : null)
      : typedValue(flowType, accepted);
  };
  const text = (candidate: unknown) => (typeof candidate === "string" ? candidate : undefined);
  switch (type) {
    case "text":
    case "long_text":
    case "email_address":
    case "phone_number":
    case "web_address":
    case "reference_number":
      return mapped("text", text);
    case "choice":
      return mapped("choice", text);
    case "whole_number":
      return mapped("whole_number", (candidate) =>
        typeof candidate === "number" && Number.isSafeInteger(candidate) ? candidate : undefined,
      );
    // An action `number` input is a finite number that the flow declares as a decimal.
    case "number":
      return mapped("decimal_number", (candidate) =>
        typeof candidate === "number" && Number.isFinite(candidate)
          ? normalizeExactDecimal(String(candidate))
          : undefined,
      );
    case "decimal_number":
      return mapped("decimal_number", (candidate) =>
        typeof candidate === "string" && parseExactDecimal(candidate) !== undefined
          ? candidate
          : undefined,
      );
    case "money":
      return mapped("money", (candidate) =>
        isPlainObject(candidate) && typeof candidate.amount === "string" &&
        parseExactDecimal(candidate.amount) !== undefined
          ? candidate.amount
          : undefined,
      );
    case "yes_no":
    case "boolean":
      return mapped("yes_no", (candidate) => (typeof candidate === "boolean" ? candidate : undefined));
    case "date":
      return mapped("date", text);
    case "date_time":
      return mapped("date_time", text);
    case "several_choices":
      return mapped("several_choices", (candidate) =>
        Array.isArray(candidate) && candidate.every((item) => typeof item === "string")
          ? (candidate as string[])
          : undefined,
      );
    case "link":
    case "link_to_one_of_several":
    case "record_reference":
      return mapped("record_reference", (candidate) =>
        isPlainObject(candidate) && typeof candidate.recordId === "string"
          ? candidate.recordId
          : undefined,
      );
    case "link_to_person":
      return mapped("organization_account_reference", (candidate) =>
        isPlainObject(candidate) && typeof candidate.organizationAccountId === "string"
          ? candidate.organizationAccountId
          : undefined,
      );
    case "organization_account_reference":
      return mapped("organization_account_reference", text);
    default:
      return typedValue(
        "json",
        value !== undefined && jsonValueSchema.safeParse(value).success ? (value as JsonValue) : null,
      );
  }
};

/**
 * The record and the inputs a named action's flow reads, in the flow's own typed view. The subject
 * record's identity is added by the flow runner under the input the flow declares for it.
 */
export const actionFlowSeed = (
  prepared: PreparedNamedAction,
  normalizedInputs: Readonly<Record<string, JsonValue>>,
  issuedAt: string,
): ActionFlowSeed => ({
  triggerRecord: Object.fromEntries(
    prepared.recordType.fields.map((field) => [
      field.key,
      flowRuntimeValue(
        field.type,
        hasOwn(prepared.existingValues, field.fieldId) ? prepared.existingValues[field.fieldId] : null,
      ),
    ]),
  ),
  inputs: Object.fromEntries(
    prepared.action.inputs
      .filter((input) => hasOwn(normalizedInputs, input.key))
      .map((input) => [input.key, flowRuntimeValue(input.type, normalizedInputs[input.key])]),
  ),
  declaredInputKeys: prepared.action.inputs.map((input) => input.key),
  subjectRecordId: prepared.recordId,
  actor: prepared.actorOrganizationAccountId,
  now: issuedAt,
});

// ─── What the flow asked for ──────────────────────────────────────────────────────────────────

type FlowValueJson = Readonly<
  | { kind: "literal"; literal: { type: string; value: JsonValue } }
  | { kind: "reference"; reference: Readonly<Record<string, unknown>> }
>;

const isFlowValue = (candidate: unknown): candidate is FlowValueJson => {
  if (!isPlainObject(candidate)) return false;
  if (candidate.kind === "literal")
    return isPlainObject(candidate.literal) && hasOwn(candidate.literal, "value");
  return candidate.kind === "reference" && isPlainObject(candidate.reference);
};

type ActionEffect = NamedActionDefinition["effects"][number];

/**
 * What a compiled value reads, resolved against whichever record type owns the field being written:
 * a literal, an action input, a subject field, the subject record itself, the actor or the one
 * checked operation time. A flow value is a single typed value, so it is never coerced.
 */
const writtenValue = (
  prepared: PreparedNamedAction,
  normalizedInputs: Readonly<Record<string, JsonValue>>,
  subjectInput: string,
  issuedAt: string,
  field: RecordTypeDefinition["fields"][number],
  candidate: unknown,
): JsonValue | undefined => {
  if (!isFlowValue(candidate)) return undefined;
  let value: unknown;
  if (candidate.kind === "literal") value = candidate.literal.value;
  else {
    const reference = candidate.reference;
    if (reference.source === "input" && typeof reference.name === "string") {
      if (reference.name === subjectInput)
        value = { recordTypeId: prepared.recordType.recordTypeId, recordId: prepared.recordId };
      else if (hasOwn(normalizedInputs, reference.name)) value = normalizedInputs[reference.name];
      else return undefined;
    } else if (reference.source === "trigger_record" && typeof reference.field === "string") {
      const subjectField = prepared.recordType.fields.find((item) => item.key === reference.field);
      if (subjectField === undefined) return undefined;
      value = hasOwn(prepared.existingValues, subjectField.fieldId)
        ? prepared.existingValues[subjectField.fieldId]
        : null;
    } else if (reference.source === "execution_actor")
      value =
        field.type === "link_to_person"
          ? { organizationAccountId: prepared.actorOrganizationAccountId }
          : prepared.actorOrganizationAccountId;
    else if (reference.source === "execution_now") value = issuedAt;
    else return undefined;
  }
  return jsonValueSchema.safeParse(value).success ? (value as JsonValue) : undefined;
};

/** The field-id keyed map of flow values a compiled record task carries, or undefined. */
const valueMap = (
  call: FlowProtectedTaskCall,
  property: string,
): Readonly<Record<string, unknown>> | undefined => {
  const carried = call.properties[property]?.value;
  return isPlainObject(carried) ? carried : undefined;
};

const textProperty = (call: FlowProtectedTaskCall, property: string): string | undefined => {
  const carried = call.properties[property]?.value;
  return typeof carried === "string" ? carried : undefined;
};

/** The effect a collected task stands for is the one named by its compiled task id. */
const effectOrdinal = (taskId: string, effectCount: number): number | undefined => {
  const match = /^effect_(\d+)$/.exec(taskId);
  if (match === null) return undefined;
  const ordinal = Number(match[1]) - 1;
  return Number.isSafeInteger(ordinal) && ordinal >= 0 && ordinal < effectCount ? ordinal : undefined;
};

const sameKeys = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length &&
  [...left].map((key) => key.toLowerCase()).sort().join("|") ===
    [...right].map((key) => key.toLowerCase()).sort().join("|");

/**
 * Resolves one `copy_relationships` effect against the subject. The target is read through the
 * action's `record_reference` input, which must name another record of the subject's own record
 * type: the copied relationships are the subject's, so only a same-type record can hold them. Every
 * selected id must be a `many_to_one` relationship the subject declares (a `one_to_one` link cannot
 * be held by a second record), whose link field the actor can currently read and that no earlier
 * `set_field` effect changes: the database copies the subject's edge as it stands before the
 * command writes the subject. Nothing is copied that the action did not name.
 */
const relationshipCopy = (
  prepared: PreparedNamedAction,
  normalizedInputs: Readonly<Record<string, JsonValue>>,
  ordinal: number,
  effect: Extract<ActionEffect, { kind: "copy_relationships" }>,
  earlierSetFieldIds: ReadonlySet<string>,
): NamedActionRelationshipCopy | undefined => {
  if (!hasOwn(normalizedInputs, effect.targetInputKey)) return undefined;
  const target = recordLinkValueV2Schema.safeParse(normalizedInputs[effect.targetInputKey]);
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
  for (const relationshipId of effect.relationshipIds) {
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
      earlierSetFieldIds.has(relationship.fromFieldId.toLowerCase())
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
 * Turns the record tasks an action's flow collected into the composition `apply_record_changes`
 * applies. Every collected task must be the compiled task of exactly one installed effect, of the
 * kind that effect has, and every installed effect must be covered once; anything else means the
 * flow is not the installed action's, and the action is refused as invalid.
 */
export const composeFlowEffects = (
  prepared: PreparedNamedAction,
  normalizedInputs: Readonly<Record<string, JsonValue>>,
  collected: Extract<ActionFlowOutcome, { kind: "collected" }>,
  issuedAt: string,
): NamedActionComposition | undefined => {
  const effects = prepared.action.effects;
  const byOrdinal = new Map<number, FlowProtectedTaskCall>();
  for (const call of collected.calls) {
    const ordinal = effectOrdinal(call.taskId, effects.length);
    if (ordinal === undefined || byOrdinal.has(ordinal)) return undefined;
    byOrdinal.set(ordinal, call);
  }
  if (byOrdinal.size !== effects.length) return undefined;

  const fields = new Map(prepared.recordType.fields.map((field) => [field.fieldId, field]));
  const targets = new Map(prepared.createTargets.map((target) => [target.ordinal, target]));
  const submittedValues: Record<string, JsonValue | null> = {};
  const creations: NamedActionCreation[] = [];
  const relationshipCopies: NamedActionRelationshipCopy[] = [];
  const setFieldIds = new Set<string>();
  let softDeletesSubject = false;
  const announcedEventKeys: string[] = [];

  for (const [ordinal, effect] of effects.entries()) {
    const call = byOrdinal.get(ordinal)!;
    if (effect.kind === "announce_event") {
      if (call.taskType !== "event.announce" || textProperty(call, "event") !== effect.eventKey)
        return undefined;
      announcedEventKeys.push(effect.eventKey);
      continue;
    }
    if (effect.kind === "create_record") {
      const target = targets.get(ordinal);
      const authored = valueMap(call, "values");
      if (
        call.taskType !== "record.create" ||
        target === undefined ||
        authored === undefined ||
        effect.recordType.state !== "resolved" ||
        effect.recordType.recordTypeId.toLowerCase() !== target.recordTypeId.toLowerCase() ||
        textProperty(call, "record_type")?.toLowerCase() !== target.recordTypeId.toLowerCase() ||
        !sameKeys(Object.keys(authored), Object.keys(effect.values))
      )
        return undefined;
      const targetFields = new Map<string, (typeof target.recordType.fields)[number]>(
        target.recordType.fields.map((item) => [item.fieldId, item]),
      );
      const values: Record<string, JsonValue | null> = {};
      for (const [fieldId, source] of Object.entries(authored)) {
        const field = targetFields.get(fieldId);
        if (field === undefined) return undefined;
        const value = writtenValue(
          prepared,
          normalizedInputs,
          collected.subjectInput,
          issuedAt,
          field,
          source,
        );
        if (value === undefined) return undefined;
        values[fieldId] = value;
      }
      creations.push({ ordinal, recordTypeId: target.recordTypeId, values });
      continue;
    }
    if (effect.kind === "copy_relationships") {
      const changes = call.properties.changes?.value;
      if (
        call.taskType !== "record.changes" ||
        !Array.isArray(changes) ||
        changes.length !== 1 ||
        !isPlainObject(changes[0]) ||
        changes[0].kind !== "copy_relationships" ||
        !Array.isArray(changes[0].relationshipIds) ||
        !sameKeys(
          changes[0].relationshipIds.filter((item): item is string => typeof item === "string"),
          effect.relationshipIds,
        )
      )
        return undefined;
      const copy = relationshipCopy(prepared, normalizedInputs, ordinal, effect, setFieldIds);
      if (copy === undefined) return undefined;
      relationshipCopies.push(copy);
      continue;
    }
    if (effect.kind === "soft_delete_subject") {
      const record = call.properties.record?.value;
      // One delete per action; a second could only name the same subject.
      if (
        softDeletesSubject ||
        call.taskType !== "record.delete" ||
        textProperty(call, "record_type")?.toLowerCase() !==
          prepared.recordType.recordTypeId.toLowerCase() ||
        (typeof record === "string" ? record : undefined) !== prepared.recordId
      )
        return undefined;
      softDeletesSubject = true;
      continue;
    }
    if (effect.kind !== "set_field") return undefined;
    const authored = valueMap(call, "values");
    setFieldIds.add(effect.fieldId.toLowerCase());
    const field = fields.get(effect.fieldId);
    if (
      call.taskType !== "record.set_fields" ||
      authored === undefined ||
      field === undefined ||
      !sameKeys(Object.keys(authored), [effect.fieldId])
    )
      return undefined;
    const value = writtenValue(
      prepared,
      normalizedInputs,
      collected.subjectInput,
      issuedAt,
      field,
      Object.values(authored)[0],
    );
    if (value === undefined) return undefined;
    submittedValues[effect.fieldId] = value;
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
