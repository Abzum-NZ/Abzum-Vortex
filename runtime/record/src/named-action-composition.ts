import {
  actionDefinitionSchema,
  actionDefinitionV2Schema,
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
  recordTypeDefinitionV2Schema,
  recordRichTextDocumentV2Schema,
  timestampSchema,
  type ConditionNode,
  type JsonValue,
  type ModuleFieldV2,
} from "@vortex/contracts";
import { evaluateTypedCondition, evaluateTypedConditionV2 } from "@vortex/rule";

type NamedActionDefinition =
  | ReturnType<typeof actionDefinitionSchema.parse>
  | ReturnType<typeof actionDefinitionV2Schema.parse>;

export type PreparedNamedAction = Readonly<{
  validationContractVersion: "1.0.0" | "2.0.0" | "3.0.0";
  action: NamedActionDefinition;
  recordType: ReturnType<typeof recordTypeDefinitionV2Schema.parse>;
  recordId: string;
  existingValues: Readonly<Record<string, unknown>>;
  actorOrganizationAccountId: string;
}>;

export type NamedActionComposition = Readonly<{
  submittedValues: Readonly<Record<string, JsonValue | null>>;
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
  exactValues: boolean,
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
      try {
        if (!new RegExp(input.validation.pattern, "u").test(candidate)) return undefined;
      } catch {
        return undefined;
      }
    }
    return candidate;
  }
  if (input.type === "formatted_text") {
    if (!exactValues) {
      if (typeof candidate !== "string") return undefined;
      return input.validation?.maximumLength === undefined ||
        candidate.length <= input.validation.maximumLength
        ? candidate
        : undefined;
    }
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
    if (!exactValues || typeof candidate !== "string") return undefined;
    const normalized = normalizeExactDecimal(candidate);
    return normalized !== undefined && exactWithin(normalized, input.validation)
      ? normalized
      : undefined;
  }
  if (input.type === "money") {
    if (!exactValues) {
      if (typeof candidate !== "number" || !Number.isFinite(candidate)) return undefined;
      const minimum = input.validation?.minimum;
      const maximum = input.validation?.maximum;
      return (typeof minimum !== "number" || candidate >= minimum) &&
        (typeof maximum !== "number" || candidate <= maximum)
        ? candidate
        : undefined;
    }
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
    if (!exactValues)
      return typeof candidate === "string" && jsonValueSchema.safeParse(candidate).success
        ? candidate
        : undefined;
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
  const exactValues = prepared.validationContractVersion !== "1.0.0";
  const result: Record<string, JsonValue> = {};
  for (const input of prepared.action.inputs) {
    if (!hasOwn(supplied, input.key)) {
      if (input.required) return undefined;
      continue;
    }
    const parsed = inputValue(input, supplied[input.key], exactValues);
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
  if (prepared.validationContractVersion === "1.0.0")
    return evaluateTypedCondition({
      condition: prepared.action.precondition,
      sourceRecordFields: fields as never,
      declaredFieldIds: used.fieldIds,
      parameterDeclarations: declarations.map((input) => ({
        key: input.key,
        type: input.type as
          "text" | "number" | "boolean" | "date" | "date_time" | "organization_account_reference",
      })),
      fieldValues,
      parameterValues,
    });
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
  const submittedValues: Record<string, JsonValue | null> = {};
  const announcedEventKeys: string[] = [];
  for (const effect of prepared.action.effects) {
    if (effect.kind === "announce_event") {
      announcedEventKeys.push(effect.eventKey);
      continue;
    }
    if (effect.kind !== "set_field") return undefined;
    const field = fields.get(effect.fieldId);
    if (field === undefined) return undefined;
    let value: unknown;
    if (effect.value.source === "literal") value = effect.value.value;
    else if (effect.value.source === "input") {
      if (!hasOwn(normalizedInputs, effect.value.inputKey)) return undefined;
      value = normalizedInputs[effect.value.inputKey];
    } else if (effect.value.source === "subject_field")
      value = hasOwn(prepared.existingValues, effect.value.fieldId)
        ? prepared.existingValues[effect.value.fieldId]
        : null;
    else if (effect.value.source === "subject_record")
      value = {
        recordTypeId: prepared.recordType.recordTypeId,
        recordId: prepared.recordId,
      };
    else if (effect.value.source === "current_actor")
      value =
        field.type === "link_to_person"
          ? { organizationAccountId: prepared.actorOrganizationAccountId }
          : prepared.actorOrganizationAccountId;
    else value = issuedAt;
    if (!jsonValueSchema.safeParse(value).success) return undefined;
    submittedValues[effect.fieldId] = value as JsonValue;
  }
  return { submittedValues, announcedEventKeys, normalizedInputs, preconditionSatisfied };
};
