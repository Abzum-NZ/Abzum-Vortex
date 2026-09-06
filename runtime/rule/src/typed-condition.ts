import {
  builderKeySchema,
  conditionNodeSchema,
  fieldDefinitionSchema,
  fieldIdSchema,
  jsonValueSchema,
  platformIdSchema,
  type ConditionNode,
  type FieldDefinition,
  type JsonValue,
} from "@vortex/contracts";

export const typedConditionEvaluationErrorReasons = [
  "input_refused",
  "field_refused",
  "parameter_refused",
  "operator_refused",
] as const;

export type TypedConditionEvaluationErrorReason =
  (typeof typedConditionEvaluationErrorReasons)[number];

export class TypedConditionEvaluationError extends Error {
  constructor(readonly reason: TypedConditionEvaluationErrorReason) {
    super(`vortex.rule.typed_condition_${reason}`);
    this.name = "TypedConditionEvaluationError";
  }
}

export type TypedConditionParameterDeclaration = Readonly<{
  key: string;
  type: "text" | "number" | "boolean" | "date" | "date_time" | "organization_account_reference";
}>;

export type TypedConditionEvaluationInput = Readonly<{
  condition: ConditionNode;
  sourceRecordFields: readonly FieldDefinition[];
  declaredFieldIds: readonly string[];
  parameterDeclarations: readonly TypedConditionParameterDeclaration[];
  fieldValues: Readonly<Record<string, unknown>>;
  parameterValues: Readonly<Record<string, unknown>>;
}>;

type SemanticType =
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "date_time"
  | "text_collection"
  | "opaque_json"
  | "record_reference"
  | "organization_account_reference";

type Operand = Readonly<{
  type?: SemanticType;
  literal?: JsonValue;
  value: JsonValue;
}>;

const refuse = (reason: TypedConditionEvaluationErrorReason): never => {
  throw new TypedConditionEvaluationError(reason);
};

const hasOwn = (value: Readonly<Record<string, unknown>>, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const sameKeys = (actual: readonly string[], expected: ReadonlySet<string>) =>
  actual.length === expected.size && actual.every((key) => expected.has(key));

const supportedOperators = new Set([
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "in",
  "not_in",
  "greater_than",
  "greater_than_or_equal",
  "less_than",
  "less_than_or_equal",
  "is_empty",
  "is_not_empty",
]);

const containsUnsupportedOperator = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (value.kind === "comparison")
    return typeof value.operator === "string" && !supportedOperators.has(value.operator);
  if ((value.kind === "all" || value.kind === "any") && Array.isArray(value.conditions))
    return value.conditions.some(containsUnsupportedOperator);
  return value.kind === "not" && containsUnsupportedOperator(value.condition);
};

const validDate = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
};

const validText = (value: unknown): value is string => {
  if (typeof value !== "string" || value.includes("\0")) return false;
  return [...value].every((entry) => {
    const point = entry.codePointAt(0)!;
    return point < 0xd800 || point > 0xdfff;
  });
};

const instantMicros = (value: unknown): bigint | undefined => {
  if (typeof value !== "string") return undefined;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const local = new Date(0);
  local.setUTCHours(hour, minute, second, 0);
  local.setUTCFullYear(year, month - 1, day);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day
  )
    return undefined;
  const zone = match[8]!;
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetRemainder = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetRemainder > 59) return undefined;
    offsetMinutes = (offsetHours * 60 + offsetRemainder) * (zone[0] === "+" ? 1 : -1);
  }
  const fractionalMicros = BigInt((match[7] ?? "").padEnd(6, "0"));
  return BigInt(local.getTime() - offsetMinutes * 60_000) * 1_000n + fractionalMicros;
};

const semanticTypeForField = (field: FieldDefinition): SemanticType => {
  switch (field.type) {
    case "whole_number":
    case "decimal_number":
    case "money":
      return "number";
    case "yes_no":
      return "boolean";
    case "date":
      return "date";
    case "date_time":
      return "date_time";
    case "several_choices":
      return "text_collection";
    case "table":
    case "attachment":
      return "opaque_json";
    case "link":
    case "link_to_one_of_several":
      return "record_reference";
    case "link_to_person":
      return "organization_account_reference";
    case "calculation":
    case "total": {
      const resultType = field.settings.resultType;
      if (["whole_number", "decimal_number", "money"].includes(resultType)) return "number";
      if (resultType === "yes_no") return "boolean";
      if (resultType === "date") return "date";
      if (resultType === "date_time") return "date_time";
      return "text";
    }
    default:
      return "text";
  }
};

const valueMatchesType = (value: JsonValue, type: SemanticType): boolean => {
  if (value === null) return true;
  switch (type) {
    case "text":
      return validText(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return validDate(value);
    case "date_time":
      return instantMicros(value) !== undefined;
    case "text_collection":
      return Array.isArray(value) && value.every(validText);
    case "record_reference":
    case "organization_account_reference":
      return typeof value === "string" && platformIdSchema.safeParse(value).success;
    case "opaque_json":
      return jsonValueSchema.safeParse(value).success;
  }
};

const exactJsonEqual = (left: JsonValue, right: JsonValue): boolean => {
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object")
    return left === right;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => exactJsonEqual(entry, right[index]!))
    );
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && exactJsonEqual(left[key]!, right[rightKeys[index]!]!),
    )
  );
};

const codePointCompare = (left: string, right: string): number => {
  const leftPoints = [...left].map((entry) => entry.codePointAt(0)!);
  const rightPoints = [...right].map((entry) => entry.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
};

const scalarEqual = (left: Operand, right: Operand, type: SemanticType): boolean => {
  if (left.value === null || right.value === null) return left.value === right.value;
  if (type === "date_time") return instantMicros(left.value) === instantMicros(right.value);
  if (type === "record_reference" || type === "organization_account_reference")
    return String(left.value).toLowerCase() === String(right.value).toLowerCase();
  return exactJsonEqual(left.value, right.value);
};

const literalMatchesType = (value: JsonValue, type: SemanticType): boolean =>
  value === null || valueMatchesType(value, type);

const sharedType = (left: Operand, right: Operand): SemanticType | undefined => {
  if (left.type && right.type) return left.type === right.type ? left.type : undefined;
  if (left.type)
    return right.literal !== undefined && literalMatchesType(right.literal, left.type)
      ? left.type
      : undefined;
  if (right.type)
    return left.literal !== undefined && literalMatchesType(left.literal, right.type)
      ? right.type
      : undefined;
  if (left.literal === null && right.literal === null) return "opaque_json";
  if (left.literal === null && right.literal !== undefined)
    return naturalLiteralType(right.literal);
  if (right.literal === null && left.literal !== undefined) return naturalLiteralType(left.literal);
  const leftType = left.literal === undefined ? undefined : naturalLiteralType(left.literal);
  const rightType = right.literal === undefined ? undefined : naturalLiteralType(right.literal);
  return leftType === rightType ? leftType : undefined;
};

const naturalLiteralType = (value: JsonValue): SemanticType | undefined => {
  if (value === null) return undefined;
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") {
    if (validDate(value)) return "date";
    if (instantMicros(value) !== undefined) return "date_time";
    return "text";
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
    return "text_collection";
  return "opaque_json";
};

const isCollectionElementType = (
  type: SemanticType | undefined,
): type is Exclude<SemanticType, "text_collection" | "opaque_json"> =>
  type !== undefined && type !== "text_collection" && type !== "opaque_json";

const collectionElementType = (
  operand: Operand,
  expectedType?: SemanticType,
): SemanticType | undefined => {
  if (operand.type === "text_collection") return "text";
  if (!operand.type && Array.isArray(operand.literal)) {
    const values = operand.literal;
    if (values.length === 0)
      return isCollectionElementType(expectedType) ? expectedType : undefined;
    if (
      isCollectionElementType(expectedType) &&
      values.every((value) => literalMatchesType(value, expectedType))
    )
      return expectedType;
    const types = values.map(naturalLiteralType);
    return types.every((type) => type === types[0]) && isCollectionElementType(types[0])
      ? types[0]
      : undefined;
  }
  return undefined;
};

const valueCanBeType = (operand: Operand, type: SemanticType): boolean =>
  operand.type
    ? operand.type === type
    : operand.literal !== undefined && literalMatchesType(operand.literal, type);

export function evaluateTypedCondition(input: TypedConditionEvaluationInput): boolean {
  const candidateInput = input as unknown;
  if (
    !isRecord(candidateInput) ||
    !Array.isArray(candidateInput.sourceRecordFields) ||
    !Array.isArray(candidateInput.declaredFieldIds) ||
    !Array.isArray(candidateInput.parameterDeclarations) ||
    !isRecord(candidateInput.fieldValues) ||
    !isRecord(candidateInput.parameterValues)
  )
    refuse("input_refused");
  const safeInput = candidateInput as unknown as TypedConditionEvaluationInput;
  const parsedCondition = conditionNodeSchema.safeParse(safeInput.condition);
  if (!parsedCondition.success)
    refuse(containsUnsupportedOperator(safeInput.condition) ? "operator_refused" : "input_refused");
  const parsedFields = safeInput.sourceRecordFields.map((field) =>
    fieldDefinitionSchema.safeParse(field),
  );
  if (parsedFields.some((field) => !field.success)) refuse("input_refused");
  const fields: FieldDefinition[] = [];
  for (const parsedField of parsedFields) {
    if (!parsedField.success) refuse("input_refused");
    fields.push(parsedField.data!);
  }
  const fieldIds = fields.map((field) => field.fieldId);
  if (new Set(fieldIds).size !== fieldIds.length) refuse("input_refused");
  const fieldsById = new Map<string, FieldDefinition>(
    fields.map((field) => [field.fieldId, field]),
  );

  const declaredFieldIds = safeInput.declaredFieldIds.map((fieldId) => {
    const parsed = fieldIdSchema.safeParse(fieldId);
    if (!parsed.success) refuse("field_refused");
    return parsed.data!;
  });
  if (
    new Set(declaredFieldIds).size !== declaredFieldIds.length ||
    declaredFieldIds.some((fieldId) => !fieldsById.has(fieldId))
  )
    refuse("field_refused");
  const declaredFields = new Set<string>(declaredFieldIds);

  if (
    safeInput.parameterDeclarations.some(
      (parameter) =>
        !isRecord(parameter) || !sameKeys(Object.keys(parameter), new Set(["key", "type"])),
    )
  )
    refuse("parameter_refused");
  const parameterDeclarations =
    safeInput.parameterDeclarations as readonly TypedConditionParameterDeclaration[];
  const parameterKeys = parameterDeclarations.map((parameter) => parameter.key);
  if (
    new Set(parameterKeys).size !== parameterKeys.length ||
    parameterDeclarations.some(
      (parameter) =>
        !builderKeySchema.safeParse(parameter.key).success ||
        ![
          "text",
          "number",
          "boolean",
          "date",
          "date_time",
          "organization_account_reference",
        ].includes(parameter.type),
    )
  )
    refuse("parameter_refused");
  const parameterTypes = new Map(
    parameterDeclarations.map((parameter) => [parameter.key, parameter.type] as const),
  );

  const suppliedFieldIds = Object.keys(safeInput.fieldValues);
  if (
    new Set(suppliedFieldIds).size !== suppliedFieldIds.length ||
    !sameKeys(suppliedFieldIds, declaredFields)
  )
    refuse("input_refused");
  const canonicalFieldValues = new Map<string, JsonValue>();
  for (const [key, value] of Object.entries(safeInput.fieldValues)) {
    const canonicalKey = key;
    const field = fieldsById.get(canonicalKey);
    if (
      !declaredFields.has(canonicalKey) ||
      !field ||
      !jsonValueSchema.safeParse(value).success ||
      !valueMatchesType(value as JsonValue, semanticTypeForField(field))
    )
      refuse("input_refused");
    canonicalFieldValues.set(canonicalKey, value as JsonValue);
  }
  if (!sameKeys(Object.keys(safeInput.parameterValues), new Set(parameterKeys)))
    refuse("input_refused");
  for (const [key, value] of Object.entries(safeInput.parameterValues)) {
    const type = parameterTypes.get(key);
    if (
      !type ||
      value === null ||
      !jsonValueSchema.safeParse(value).success ||
      !valueMatchesType(value as JsonValue, type)
    )
      refuse("input_refused");
  }

  const operand = (entry: unknown): Operand => {
    const value = entry as { source: string; fieldId?: string; key?: string; value?: JsonValue };
    if (value.source === "field") {
      const fieldId = String(value.fieldId);
      const field = fieldsById.get(fieldId);
      if (!declaredFields.has(fieldId) || !field || !canonicalFieldValues.has(fieldId))
        refuse("field_refused");
      return { type: semanticTypeForField(field!), value: canonicalFieldValues.get(fieldId)! };
    }
    if (value.source === "parameter") {
      const key = String(value.key);
      const type = parameterTypes.get(key);
      if (!type || !hasOwn(safeInput.parameterValues, key)) refuse("parameter_refused");
      return { type: type as SemanticType, value: safeInput.parameterValues[key] as JsonValue };
    }
    if (value.source !== "value" || !jsonValueSchema.safeParse(value.value).success)
      refuse("input_refused");
    return { literal: value.value as JsonValue, value: value.value as JsonValue };
  };

  type ConditionObject = {
    kind: string;
    conditions?: unknown[];
    condition?: unknown;
    operator?: string;
    left?: unknown;
    right?: unknown;
  };

  const validate = (candidate: unknown): void => {
    const condition = candidate as ConditionObject;
    if (condition.kind === "all" || condition.kind === "any") {
      condition.conditions!.forEach(validate);
      return;
    }
    if (condition.kind === "not") {
      validate(condition.condition!);
      return;
    }
    const left = operand(condition.left);
    if (condition.operator === "is_empty" || condition.operator === "is_not_empty") return;
    const right = operand(condition.right);
    if (condition.operator === "equals" || condition.operator === "not_equals") {
      if (!sharedType(left, right)) refuse("operator_refused");
      return;
    }
    if (condition.operator === "contains" || condition.operator === "not_contains") {
      const validText = valueCanBeType(left, "text") && valueCanBeType(right, "text");
      const elementType = collectionElementType(left, right.type);
      if (!validText && (!elementType || !valueCanBeType(right, elementType)))
        refuse("operator_refused");
      return;
    }
    if (condition.operator === "in" || condition.operator === "not_in") {
      const elementType = collectionElementType(right, left.type);
      if (!elementType || !valueCanBeType(left, elementType)) refuse("operator_refused");
      return;
    }
    const type = sharedType(left, right);
    if (!type || !["text", "number", "date", "date_time"].includes(type))
      refuse("operator_refused");
  };

  validate(parsedCondition.data!);

  const evaluate = (candidate: unknown): boolean => {
    const condition = candidate as ConditionObject;
    if (condition.kind === "all") return condition.conditions!.map(evaluate).every(Boolean);
    if (condition.kind === "any") return condition.conditions!.map(evaluate).some(Boolean);
    if (condition.kind === "not") return !evaluate(condition.condition!);
    const left = operand(condition.left);
    if (condition.operator === "is_empty") return left.value === null || left.value === "";
    if (condition.operator === "is_not_empty") return left.value !== null && left.value !== "";
    const right = operand(condition.right);
    const type = sharedType(left, right)!;
    if (condition.operator === "equals" || condition.operator === "not_equals") {
      const equal = scalarEqual(left, right, type);
      return condition.operator === "equals" ? equal : !equal;
    }
    if (condition.operator === "contains" || condition.operator === "not_contains") {
      const elementType = collectionElementType(left, right.type);
      const contains =
        left.value !== null &&
        right.value !== null &&
        (typeof left.value === "string"
          ? left.value.includes(String(right.value))
          : Array.isArray(left.value) &&
            left.value.some((entry) =>
              scalarEqual({ literal: entry, value: entry }, right, elementType!),
            ));
      return condition.operator === "contains" ? contains : !contains;
    }
    if (condition.operator === "in" || condition.operator === "not_in") {
      const elementType = collectionElementType(right, left.type)!;
      const included =
        left.value !== null &&
        right.value !== null &&
        Array.isArray(right.value) &&
        right.value.some((entry) =>
          scalarEqual(left, { literal: entry, value: entry }, elementType),
        );
      return condition.operator === "in" ? included : !included;
    }
    if (left.value === null || right.value === null) return false;
    let comparison: number;
    if (type === "number") comparison = Number(left.value) - Number(right.value);
    else if (type === "date_time")
      comparison =
        instantMicros(left.value)! < instantMicros(right.value)!
          ? -1
          : instantMicros(left.value)! > instantMicros(right.value)!
            ? 1
            : 0;
    else comparison = codePointCompare(String(left.value), String(right.value));
    if (condition.operator === "greater_than") return comparison > 0;
    if (condition.operator === "greater_than_or_equal") return comparison >= 0;
    if (condition.operator === "less_than") return comparison < 0;
    return comparison <= 0;
  };

  return evaluate(parsedCondition.data!);
}
