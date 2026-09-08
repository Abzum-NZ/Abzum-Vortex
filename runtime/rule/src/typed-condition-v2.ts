import {
  builderKeySchema,
  compareExactDecimals,
  conditionNodeSchema,
  exactDecimalTextV2Schema,
  fieldIdSchema,
  jsonValueSchema,
  moduleFieldV2Schema,
  moduleFieldValueV2Schemas,
  moneyValueV2Schema,
  organizationAccountIdSchema,
  parseExactDecimal,
  personLinkValueV2Schema,
  recordLinkValueV2Schema,
  type ConditionNode,
  type ExactDecimal,
  type JsonValue,
  type ModuleFieldV2,
} from "@vortex/contracts";
import {
  TypedConditionEvaluationError,
  type TypedConditionEvaluationErrorReason,
} from "./typed-condition";
import {
  codePointCompare,
  evaluateResolvedTypedCondition,
  exactJsonEqual,
  instantMicros,
  type ResolvedTypedConditionOperand,
  validDate,
  validText,
} from "./typed-condition-core";

export type TypedConditionParameterDeclarationV2 = Readonly<{
  key: string;
  type:
    | "text"
    | "number"
    | "decimal_number"
    | "money"
    | "boolean"
    | "date"
    | "date_time"
    | "organization_account_reference";
}>;

export type TypedConditionEvaluationInputV2 = Readonly<{
  condition: ConditionNode;
  sourceRecordFields: readonly ModuleFieldV2[];
  declaredFieldIds: readonly string[];
  parameterDeclarations: readonly TypedConditionParameterDeclarationV2[];
  fieldValues: Readonly<Record<string, unknown>>;
  parameterValues: Readonly<Record<string, unknown>>;
}>;

type SemanticTypeV2 =
  | "text"
  | "number"
  | "whole_number"
  | "decimal_number"
  | "money"
  | "boolean"
  | "date"
  | "date_time"
  | "text_collection"
  | "opaque_json"
  | "record_reference"
  | "organization_account_reference";

type OperandV2 = ResolvedTypedConditionOperand<SemanticTypeV2>;

const parameterTypesV2 = new Set<TypedConditionParameterDeclarationV2["type"]>([
  "text",
  "number",
  "decimal_number",
  "money",
  "boolean",
  "date",
  "date_time",
  "organization_account_reference",
]);

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

const refuse = (reason: TypedConditionEvaluationErrorReason): never => {
  throw new TypedConditionEvaluationError(reason);
};

const hasOwn = (value: Readonly<Record<string, unknown>>, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const sameKeys = (actual: readonly string[], expected: ReadonlySet<string>) =>
  actual.length === expected.size && actual.every((key) => expected.has(key));

const containsUnsupportedOperator = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (value.kind === "comparison")
    return typeof value.operator === "string" && !supportedOperators.has(value.operator);
  if ((value.kind === "all" || value.kind === "any") && Array.isArray(value.conditions))
    return value.conditions.some(containsUnsupportedOperator);
  return value.kind === "not" && containsUnsupportedOperator(value.condition);
};

const semanticTypeForField = (field: ModuleFieldV2): SemanticTypeV2 => {
  switch (field.type) {
    case "whole_number":
      return "whole_number";
    case "decimal_number":
      return "decimal_number";
    case "money":
      return "money";
    case "yes_no":
      return "boolean";
    case "date":
      return "date";
    case "date_time":
      return "date_time";
    case "several_choices":
      return "text_collection";
    case "formatted_text":
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
      if (resultType === "whole_number") return "whole_number";
      if (resultType === "decimal_number") return "decimal_number";
      if (resultType === "money") return "money";
      if (resultType === "yes_no") return "boolean";
      if (resultType === "date") return "date";
      if (resultType === "date_time") return "date_time";
      return "text";
    }
    default:
      return "text";
  }
};

const valueMatchesType = (value: JsonValue, type: SemanticTypeV2): boolean => {
  if (value === null) return true;
  switch (type) {
    case "text":
      return validText(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "whole_number":
      return typeof value === "number" && Number.isInteger(value);
    case "decimal_number":
      return exactDecimalTextV2Schema.safeParse(value).success;
    case "money":
      return moneyValueV2Schema.safeParse(value).success;
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return validDate(value);
    case "date_time":
      return instantMicros(value) !== undefined;
    case "text_collection":
      return Array.isArray(value) && value.every(validText);
    case "record_reference":
      return recordLinkValueV2Schema.safeParse(value).success;
    case "organization_account_reference":
      return (
        organizationAccountIdSchema.safeParse(value).success ||
        personLinkValueV2Schema.safeParse(value).success
      );
    case "opaque_json":
      return jsonValueSchema.safeParse(value).success;
  }
};

const valueMatchesField = (value: JsonValue, field: ModuleFieldV2): boolean => {
  if (value === null) return true;
  const leafSchema = moduleFieldValueV2Schemas[field.type];
  return (
    leafSchema.safeParse(value).success && valueMatchesType(value, semanticTypeForField(field))
  );
};

const valueMatchesParameter = (
  value: JsonValue,
  type: TypedConditionParameterDeclarationV2["type"],
): boolean =>
  type === "organization_account_reference"
    ? organizationAccountIdSchema.safeParse(value).success
    : valueMatchesType(value, type);

const naturalLiteralType = (value: JsonValue): SemanticTypeV2 | undefined => {
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

const literalMatchesType = (value: JsonValue, type: SemanticTypeV2): boolean => {
  if (value === null) return true;
  if (type === "decimal_number")
    return (
      exactDecimalTextV2Schema.safeParse(value).success ||
      (typeof value === "number" && Number.isInteger(value))
    );
  return valueMatchesType(value, type);
};

const exactFromValue = (value: JsonValue): ExactDecimal | undefined => {
  if (typeof value === "string") {
    if (!exactDecimalTextV2Schema.safeParse(value).success) return undefined;
    return parseExactDecimal(value);
  }
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return parseExactDecimal(BigInt(value).toString());
};

const exactCompatible = (operand: OperandV2): boolean => {
  if (operand.value === null) return true;
  if (
    operand.type !== undefined &&
    !["number", "whole_number", "decimal_number"].includes(operand.type)
  )
    return false;
  return exactFromValue(operand.value) !== undefined;
};

const sharedType = (left: OperandV2, right: OperandV2): SemanticTypeV2 | undefined => {
  if (left.type && right.type) {
    if (left.type === right.type) return left.type;
    if (exactCompatible(left) && exactCompatible(right)) return "decimal_number";
    return undefined;
  }
  if (left.type) {
    if (right.literal !== undefined && literalMatchesType(right.literal, left.type))
      return left.type;
    if (exactCompatible(left) && exactCompatible(right)) return "decimal_number";
    return undefined;
  }
  if (right.type) {
    if (left.literal !== undefined && literalMatchesType(left.literal, right.type))
      return right.type;
    if (exactCompatible(left) && exactCompatible(right)) return "decimal_number";
    return undefined;
  }
  if (left.literal === null && right.literal === null) return "opaque_json";
  if (left.literal === null && right.literal !== undefined)
    return naturalLiteralType(right.literal);
  if (right.literal === null && left.literal !== undefined) return naturalLiteralType(left.literal);
  const leftType = left.literal === undefined ? undefined : naturalLiteralType(left.literal);
  const rightType = right.literal === undefined ? undefined : naturalLiteralType(right.literal);
  return leftType === rightType ? leftType : undefined;
};

const isCollectionElementType = (
  type: SemanticTypeV2 | undefined,
): type is Exclude<SemanticTypeV2, "text_collection" | "opaque_json"> =>
  type !== undefined && type !== "text_collection" && type !== "opaque_json";

const collectionElementType = (
  operand: OperandV2,
  expectedType?: SemanticTypeV2,
): SemanticTypeV2 | undefined => {
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

const valueCanBeType = (operand: OperandV2, type: SemanticTypeV2): boolean =>
  operand.type
    ? operand.type === type
    : operand.literal !== undefined && literalMatchesType(operand.literal, type);

const recordReferenceIdentity = (value: JsonValue): string | undefined => {
  const parsed = recordLinkValueV2Schema.safeParse(value);
  return parsed.success
    ? `${parsed.data.recordTypeId.toLowerCase()}/${parsed.data.recordId.toLowerCase()}`
    : undefined;
};

const organizationAccountIdentity = (value: JsonValue): string | undefined => {
  const direct = organizationAccountIdSchema.safeParse(value);
  if (direct.success) return direct.data.toLowerCase();
  const linked = personLinkValueV2Schema.safeParse(value);
  return linked.success ? linked.data.organizationAccountId.toLowerCase() : undefined;
};

const moneyParts = (
  value: JsonValue,
): Readonly<{ amount: ExactDecimal; currency: string }> | undefined => {
  const parsed = moneyValueV2Schema.safeParse(value);
  if (!parsed.success) return undefined;
  const amount = exactFromValue(parsed.data.amount);
  return amount === undefined ? undefined : { amount, currency: parsed.data.currency };
};

const scalarEqual = (left: OperandV2, right: OperandV2, type: SemanticTypeV2): boolean => {
  if (left.value === null || right.value === null) return left.value === right.value;
  if (type === "date_time") return instantMicros(left.value) === instantMicros(right.value);
  if (type === "whole_number" || type === "decimal_number")
    return compareExactDecimals(exactFromValue(left.value)!, exactFromValue(right.value)!) === 0;
  if (type === "money") {
    const leftMoney = moneyParts(left.value)!;
    const rightMoney = moneyParts(right.value)!;
    return (
      leftMoney.currency === rightMoney.currency &&
      compareExactDecimals(leftMoney.amount, rightMoney.amount) === 0
    );
  }
  if (type === "record_reference")
    return recordReferenceIdentity(left.value) === recordReferenceIdentity(right.value);
  if (type === "organization_account_reference")
    return organizationAccountIdentity(left.value) === organizationAccountIdentity(right.value);
  return exactJsonEqual(left.value, right.value);
};

const orderingComparison = (left: OperandV2, right: OperandV2, type: SemanticTypeV2): number => {
  if (type === "number") return Number(left.value) - Number(right.value);
  if (type === "whole_number" || type === "decimal_number")
    return compareExactDecimals(exactFromValue(left.value)!, exactFromValue(right.value)!);
  if (type === "money") {
    const leftMoney = moneyParts(left.value)!;
    const rightMoney = moneyParts(right.value)!;
    return compareExactDecimals(leftMoney.amount, rightMoney.amount);
  }
  if (type === "date_time") {
    const leftInstant = instantMicros(left.value)!;
    const rightInstant = instantMicros(right.value)!;
    return leftInstant < rightInstant ? -1 : leftInstant > rightInstant ? 1 : 0;
  }
  return codePointCompare(String(left.value), String(right.value));
};

/** Evaluates canonical Module V2 conditions without coercing exact values through Number. */
export function evaluateTypedConditionV2(input: TypedConditionEvaluationInputV2): boolean {
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
  const safeInput = candidateInput as unknown as TypedConditionEvaluationInputV2;
  const parsedCondition = conditionNodeSchema.safeParse(safeInput.condition);
  if (!parsedCondition.success)
    refuse(containsUnsupportedOperator(safeInput.condition) ? "operator_refused" : "input_refused");

  const parsedFields = safeInput.sourceRecordFields.map((field) =>
    moduleFieldV2Schema.safeParse(field),
  );
  if (parsedFields.some((field) => !field.success)) refuse("input_refused");
  const fields: ModuleFieldV2[] = [];
  for (const parsedField of parsedFields) {
    if (!parsedField.success) refuse("input_refused");
    fields.push(parsedField.data!);
  }
  const fieldIds = fields.map((field) => field.fieldId);
  if (new Set(fieldIds).size !== fieldIds.length) refuse("input_refused");
  const fieldsById = new Map<string, ModuleFieldV2>(fields.map((field) => [field.fieldId, field]));

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
    safeInput.parameterDeclarations as readonly TypedConditionParameterDeclarationV2[];
  const parameterKeys = parameterDeclarations.map((parameter) => parameter.key);
  if (
    new Set(parameterKeys).size !== parameterKeys.length ||
    parameterDeclarations.some(
      (parameter) =>
        !builderKeySchema.safeParse(parameter.key).success || !parameterTypesV2.has(parameter.type),
    )
  )
    refuse("parameter_refused");
  const declaredParameterTypes = new Map(
    parameterDeclarations.map((parameter) => [parameter.key, parameter.type] as const),
  );

  const suppliedFieldIds = Object.keys(safeInput.fieldValues);
  if (!sameKeys(suppliedFieldIds, declaredFields)) refuse("input_refused");
  const canonicalFieldValues = new Map<string, JsonValue>();
  for (const [fieldId, value] of Object.entries(safeInput.fieldValues)) {
    const field = fieldsById.get(fieldId);
    if (
      !declaredFields.has(fieldId) ||
      !field ||
      !jsonValueSchema.safeParse(value).success ||
      !valueMatchesField(value as JsonValue, field)
    )
      refuse("input_refused");
    canonicalFieldValues.set(fieldId, value as JsonValue);
  }

  if (!sameKeys(Object.keys(safeInput.parameterValues), new Set(parameterKeys)))
    refuse("input_refused");
  for (const [key, value] of Object.entries(safeInput.parameterValues)) {
    const type = declaredParameterTypes.get(key);
    if (
      !type ||
      value === null ||
      !jsonValueSchema.safeParse(value).success ||
      !valueMatchesParameter(value as JsonValue, type)
    )
      refuse("input_refused");
  }

  const operand = (entry: unknown): OperandV2 => {
    const value = entry as { source: string; fieldId?: string; key?: string; value?: JsonValue };
    if (value.source === "field") {
      const fieldId = String(value.fieldId);
      const field = fieldsById.get(fieldId);
      if (!declaredFields.has(fieldId) || !field || !canonicalFieldValues.has(fieldId))
        refuse("field_refused");
      const declaredField = field ?? refuse("field_refused");
      return {
        type: semanticTypeForField(declaredField),
        value: canonicalFieldValues.get(fieldId)!,
      };
    }
    if (value.source === "parameter") {
      const key = String(value.key);
      const type = declaredParameterTypes.get(key);
      if (!type || !hasOwn(safeInput.parameterValues, key)) refuse("parameter_refused");
      const declaredType = type ?? refuse("parameter_refused");
      return { type: declaredType, value: safeInput.parameterValues[key] as JsonValue };
    }
    if (value.source !== "value" || !jsonValueSchema.safeParse(value.value).success)
      refuse("input_refused");
    return { literal: value.value as JsonValue, value: value.value as JsonValue };
  };

  return evaluateResolvedTypedCondition(parsedCondition.data!, {
    resolveOperand: operand,
    validateComparison: (operator, left, right) => {
      if (operator === "is_empty" || operator === "is_not_empty") return;
      const binaryRight = right ?? refuse("input_refused");
      if (operator === "equals" || operator === "not_equals") {
        if (!sharedType(left, binaryRight)) refuse("operator_refused");
        return;
      }
      if (operator === "contains" || operator === "not_contains") {
        const validTextOperands =
          valueCanBeType(left, "text") && valueCanBeType(binaryRight, "text");
        const elementType = collectionElementType(left, binaryRight.type);
        if (!validTextOperands && (!elementType || !valueCanBeType(binaryRight, elementType)))
          refuse("operator_refused");
        return;
      }
      if (operator === "in" || operator === "not_in") {
        const elementType = collectionElementType(binaryRight, left.type);
        if (!elementType || !valueCanBeType(left, elementType)) refuse("operator_refused");
        return;
      }
      const type = sharedType(left, binaryRight);
      if (
        !type ||
        ![
          "text",
          "number",
          "whole_number",
          "decimal_number",
          "money",
          "date",
          "date_time",
        ].includes(type)
      )
        refuse("operator_refused");
      if (type === "money" && left.value !== null && binaryRight.value !== null) {
        const leftMoney = moneyParts(left.value)!;
        const rightMoney = moneyParts(binaryRight.value)!;
        if (leftMoney.currency !== rightMoney.currency) refuse("operator_refused");
      }
    },
    evaluateComparison: (operator, left, right) => {
      if (operator === "is_empty") return left.value === null || left.value === "";
      if (operator === "is_not_empty") return left.value !== null && left.value !== "";
      const binaryRight = right ?? refuse("input_refused");
      const type = sharedType(left, binaryRight)!;
      if (operator === "equals" || operator === "not_equals") {
        const equal = scalarEqual(left, binaryRight, type);
        return operator === "equals" ? equal : !equal;
      }
      if (operator === "contains" || operator === "not_contains") {
        const elementType = collectionElementType(left, binaryRight.type);
        const contains =
          left.value !== null &&
          binaryRight.value !== null &&
          (typeof left.value === "string"
            ? left.value.includes(String(binaryRight.value))
            : Array.isArray(left.value) &&
              left.value.some((entry) =>
                scalarEqual({ literal: entry, value: entry }, binaryRight, elementType!),
              ));
        return operator === "contains" ? contains : !contains;
      }
      if (operator === "in" || operator === "not_in") {
        const elementType = collectionElementType(binaryRight, left.type)!;
        const included =
          left.value !== null &&
          binaryRight.value !== null &&
          Array.isArray(binaryRight.value) &&
          binaryRight.value.some((entry) =>
            scalarEqual(left, { literal: entry, value: entry }, elementType),
          );
        return operator === "in" ? included : !included;
      }
      if (left.value === null || binaryRight.value === null) return false;
      const comparison = orderingComparison(left, binaryRight, type);
      if (operator === "greater_than") return comparison > 0;
      if (operator === "greater_than_or_equal") return comparison >= 0;
      if (operator === "less_than") return comparison < 0;
      return comparison <= 0;
    },
  });
}
