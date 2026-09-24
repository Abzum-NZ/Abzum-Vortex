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
  type ConditionNode,
  type JsonValue,
} from "@vortex/contracts";
import { evaluateTypedConditionV2 } from "@vortex/rule";

type NamedActionDefinition = ReturnType<typeof actionDefinitionV2Schema.parse>;

/**
 * One `create_record` target resolved by the database from the published
 * resolved record-type reference. The runtime never looks a target up itself.
 */
export type NamedActionCreateTarget = Readonly<{
  ordinal: number;
  recordTypeId: string;
  recordType: ReturnType<typeof recordTypeDefinitionV2Schema.parse>;
}>;

export type PreparedNamedAction = Readonly<{
  /**
   * The sole current Module validation contract the subject Record's owning
   * Module release was published under. It is checked, never branched on: every
   * value here follows the one exact Module field and action model.
   */
  validationContractVersion: "3.0.0";
  action: NamedActionDefinition;
  recordType: ReturnType<typeof recordTypeDefinitionV2Schema.parse>;
  recordId: string;
  existingValues: Readonly<Record<string, unknown>>;
  actorOrganizationAccountId: string;
  createTargets: readonly NamedActionCreateTarget[];
  /**
   * The subject fields the actor may currently read under the named action.
   * A `copy_relationships` effect only copies relationships whose link field is
   * in this set, so an action that copies relationships must supply it.
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
 * One `copy_relationships` effect, resolved. The database re-derives the same
 * plan from the installed action and the supplied inputs, so this is a
 * verified statement of intent that the preview and the final preparation must
 * agree on, never an authority the database trusts.
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
   * Whether the action soft-deletes its subject. The delete itself is never
   * composed here: it runs through the shared protected lifecycle delete after
   * the action's own effects, so this is a verified statement of intent only.
   */
  softDeletesSubject: boolean;
  announcedEventKeys: readonly string[];
  normalizedInputs: Readonly<Record<string, JsonValue>>;
  preconditionSatisfied: boolean;
}>;

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

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

const operands = (condition: ConditionNode | undefined) => {
  const fieldIds = new Set<string>();
  const inputKeys = new Set<string>();
  const visit = (node: ConditionNode): void => {
    if (node.kind === "comparison") {
      for (const operand of [node.left, node.right]) {
        if (operand?.source === "field") fieldIds.add(operand.fieldId);
        if (operand?.source === "parameter") inputKeys.add(operand.key);
      }
    } else if (node.kind === "not") visit(node.condition);
    else node.conditions.forEach(visit);
  };
  if (condition !== undefined) visit(condition);
  return { fieldIds: [...fieldIds], inputKeys: [...inputKeys] };
};

const actionInputs = (
  prepared: PreparedNamedAction,
  supplied: Readonly<Record<string, unknown>>,
): Readonly<Record<string, JsonValue>> | undefined => {
  const declared = new Set(prepared.action.inputs.map((input) => input.key));
  if (Object.keys(supplied).some((key) => !declared.has(key))) return undefined;
  const result: Record<string, JsonValue> = {};
  for (const input of prepared.action.inputs) {
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

const evaluatePrecondition = (
  prepared: PreparedNamedAction,
  inputs: Readonly<Record<string, JsonValue>>,
): boolean => {
  if (prepared.action.precondition === undefined) return true;
  const used = operands(prepared.action.precondition);
  const fields = prepared.recordType.fields.filter((field) =>
    used.fieldIds.includes(field.fieldId),
  );
  const fieldValues = Object.fromEntries(
    fields.map((field) => [field.fieldId, prepared.existingValues[field.fieldId] ?? null]),
  );
  const declarations = prepared.action.inputs.filter((input) => used.inputKeys.includes(input.key));
  const parameterValues = Object.fromEntries(
    declarations.map((input) => [input.key, inputs[input.key]]),
  );
  return evaluateTypedConditionV2({
    condition: prepared.action.precondition,
    sourceRecordFields: fields,
    declaredFieldIds: used.fieldIds,
    parameterDeclarations: declarations.map((input) => ({
      key: input.key,
      type: input.type as
        | "text"
        | "number"
        | "decimal_number"
        | "money"
        | "boolean"
        | "date"
        | "date_time"
        | "organization_account_reference",
    })),
    fieldValues,
    parameterValues,
  });
};

type ActionValue = Extract<
  NamedActionDefinition["effects"][number],
  { kind: "set_field" }
>["value"];

/**
 * The six declared value sources, resolved against whichever record type owns
 * the field being written. `create_record` reuses this unchanged against its
 * target type; every source still reads only the subject, the inputs, the
 * actor and the one checked operation time.
 */
const actionValue = (
  prepared: PreparedNamedAction,
  normalizedInputs: Readonly<Record<string, JsonValue>>,
  issuedAt: string,
  field: ReturnType<typeof recordTypeDefinitionV2Schema.parse>["fields"][number],
  source: ActionValue,
): JsonValue | undefined => {
  let value: unknown;
  if (source.source === "literal") value = source.value;
  else if (source.source === "input") {
    if (!hasOwn(normalizedInputs, source.inputKey)) return undefined;
    value = normalizedInputs[source.inputKey];
  } else if (source.source === "subject_field")
    value = hasOwn(prepared.existingValues, source.fieldId)
      ? prepared.existingValues[source.fieldId]
      : null;
  else if (source.source === "subject_record")
    value = { recordTypeId: prepared.recordType.recordTypeId, recordId: prepared.recordId };
  else if (source.source === "current_actor")
    value =
      field.type === "link_to_person"
        ? { organizationAccountId: prepared.actorOrganizationAccountId }
        : prepared.actorOrganizationAccountId;
  else value = issuedAt;
  return jsonValueSchema.safeParse(value).success ? (value as JsonValue) : undefined;
};

/**
 * Resolves one `copy_relationships` effect against the subject. The target is
 * read through the action's `record_reference` input, which must name another
 * record of the subject's own record type: the copied relationships are the
 * subject's, so only a same-type record can hold them. Every selected id must be
 * a `many_to_one` relationship the subject declares (a `one_to_one` link cannot
 * be held by a second record), whose link field the actor can currently read
 * and that no earlier `set_field` effect changes: the database copies the
 * subject's edge as it stands before the command writes the subject. Nothing is
 * copied that the action did not name.
 */
const relationshipCopy = (
  prepared: PreparedNamedAction,
  normalizedInputs: Readonly<Record<string, JsonValue>>,
  ordinal: number,
  effect: Extract<NamedActionDefinition["effects"][number], { kind: "copy_relationships" }>,
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

export const composeNamedAction = (
  prepared: PreparedNamedAction,
  suppliedInputs: Readonly<Record<string, unknown>>,
  issuedAt: string,
): NamedActionComposition | undefined => {
  const normalizedInputs = actionInputs(prepared, suppliedInputs);
  if (normalizedInputs === undefined) return undefined;
  let preconditionSatisfied: boolean;
  try {
    preconditionSatisfied = evaluatePrecondition(prepared, normalizedInputs);
  } catch {
    return undefined;
  }
  const fields = new Map(prepared.recordType.fields.map((field) => [field.fieldId, field]));
  const targets = new Map(prepared.createTargets.map((target) => [target.ordinal, target]));
  const submittedValues: Record<string, JsonValue | null> = {};
  const creations: NamedActionCreation[] = [];
  const relationshipCopies: NamedActionRelationshipCopy[] = [];
  const setFieldIds = new Set<string>();
  let softDeletesSubject = false;
  const announcedEventKeys: string[] = [];
  for (const [ordinal, effect] of prepared.action.effects.entries()) {
    if (effect.kind === "announce_event") {
      announcedEventKeys.push(effect.eventKey);
      continue;
    }
    if (effect.kind === "create_record") {
      const target = targets.get(ordinal);
      if (
        target === undefined ||
        effect.recordType.state !== "resolved" ||
        effect.recordType.recordTypeId.toLowerCase() !== target.recordTypeId.toLowerCase()
      )
        return undefined;
      const targetFields = new Map<string, (typeof target.recordType.fields)[number]>(
        target.recordType.fields.map((item) => [item.fieldId, item]),
      );
      const values: Record<string, JsonValue | null> = {};
      for (const [fieldId, source] of Object.entries(effect.values)) {
        const field = targetFields.get(fieldId);
        if (field === undefined) return undefined;
        const value = actionValue(prepared, normalizedInputs, issuedAt, field, source);
        if (value === undefined) return undefined;
        values[fieldId] = value;
      }
      creations.push({ ordinal, recordTypeId: target.recordTypeId, values });
      continue;
    }
    if (effect.kind === "copy_relationships") {
      const copy = relationshipCopy(prepared, normalizedInputs, ordinal, effect, setFieldIds);
      if (copy === undefined) return undefined;
      relationshipCopies.push(copy);
      continue;
    }
    if (effect.kind === "soft_delete_subject") {
      // One delete per action; a second could only name the same subject.
      if (softDeletesSubject) return undefined;
      softDeletesSubject = true;
      continue;
    }
    if (effect.kind !== "set_field") return undefined;
    setFieldIds.add(effect.fieldId.toLowerCase());
    const field = fields.get(effect.fieldId);
    if (field === undefined) return undefined;
    const value = actionValue(prepared, normalizedInputs, issuedAt, field, effect.value);
    if (value === undefined) return undefined;
    submittedValues[effect.fieldId] = value;
  }
  if (creations.length !== prepared.createTargets.length) return undefined;
  // The delete removes the subject the other effects would write to, link to or
  // copy from, so a deleting action may only announce Events. Refusing the
  // combination keeps every stored value and edge exactly what the action says.
  if (
    softDeletesSubject &&
    (setFieldIds.size > 0 || creations.length > 0 || relationshipCopies.length > 0)
  )
    return undefined;
  return {
    submittedValues,
    creations,
    relationshipCopies,
    softDeletesSubject,
    announcedEventKeys,
    normalizedInputs,
    preconditionSatisfied,
  };
};
