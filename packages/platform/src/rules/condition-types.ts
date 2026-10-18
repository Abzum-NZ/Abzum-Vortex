import {
  exactDecimalTextSchema,
  sourceExactDecimalTextSchema,
  moneyValueSchema,
  sourceMoneyValueSchema,
  sourceModuleFieldValueSchemas,
  moduleFieldValueSchemas,
  recordLinkValueSchema,
  recordRichTextDocumentSchema,
} from "../records/module-field-values";
import { jsonValueSchema, type JsonValue } from "../catalogue/common";
import { platformIdSchema } from "../catalogue/identifiers";
import { validText, validDate } from "./typed-condition-core";
import { flowInstantMicros } from "./flow-instant";

export type ConditionValueType =
  | "text"
  | "whole_number"
  | "decimal_number"
  | "money"
  | "yes_no"
  | "date"
  | "date_time"
  | "text_collection"
  | "opaque_json"
  | "record_reference"
  | "organization_account_reference";
export type OperandInfo = Readonly<{
  semanticType: ConditionValueType | undefined;
  literal?: JsonValue;
  source: "reference" | "value";
  field?: Record<string, unknown>;
  dialect?: "source" | "canonical";
}>;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export type ValueDialect = "source" | "canonical" | "flow";

/** Unknown declarations are refused, including on unary conditions. */
export function conditionValueType(type: unknown): ConditionValueType | undefined {
  if (typeof type !== "string") return undefined;
  if (
    [
      "text",
      "whole_number",
      "decimal_number",
      "money",
      "yes_no",
      "date",
      "date_time",
      "text_collection",
      "opaque_json",
      "record_reference",
      "organization_account_reference",
    ].includes(type)
  )
    return type as ConditionValueType;
  if (
    [
      "long_text",
      "choice",
      "reference_number",
      "email_address",
      "phone_number",
      "web_address",
    ].includes(type)
  )
    return "text";
  if (["link", "link_to_one_of_several"].includes(type)) return "record_reference";
  if (type === "several_choices") return "text_collection";
  if (["table", "attachment", "formatted_text"].includes(type)) return "opaque_json";
  return undefined;
}
export function conditionFieldType(
  field: { type?: unknown; settings?: unknown } | undefined,
): ConditionValueType | undefined {
  if (!field) return undefined;
  const settings = field.settings as Record<string, unknown> | undefined;
  return conditionValueType(
    field.type === "calculation" || field.type === "total"
      ? (settings?.resultType ?? settings?.result_type)
      : field.type,
  );
}

/** The one declared-value checker. Dialects select the shapes their contracts declare. */
export function typedValueMatchesType(
  value: unknown,
  type: string,
  dialect: ValueDialect = "canonical",
): value is JsonValue {
  switch (type) {
    case "text":
      return validText(value);
    case "whole_number":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "decimal_number":
      return (
        dialect === "source" ? sourceExactDecimalTextSchema : exactDecimalTextSchema
      ).safeParse(value).success;
    case "money":
      return dialect === "flow"
        ? exactDecimalTextSchema.safeParse(value).success
        : (dialect === "source" ? sourceMoneyValueSchema : moneyValueSchema).safeParse(value)
            .success;
    case "yes_no":
      return typeof value === "boolean";
    case "date":
      return validDate(value);
    case "date_time":
      return flowInstantMicros(value) !== undefined;
    case "record_reference":
      if (dialect === "flow") return typeof value === "string" && value.length > 0;
      if (dialect === "source") {
        const entry = value as Record<string, unknown> | null;
        return (
          entry !== null &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          typeof entry.record_type === "string" &&
          platformIdSchema.safeParse(entry.record_id).success
        );
      }
      return recordLinkValueSchema.safeParse(value).success;
    case "organization_account_reference":
      return platformIdSchema.safeParse(value).success;
    case "text_collection":
      return Array.isArray(value) && value.every(validText);
    case "opaque_json":
      return jsonValueSchema.safeParse(value).success;
    case "formatted_text":
      return recordRichTextDocumentSchema.safeParse(value).success;
    case "choice":
      return typeof value === "string" && value.length > 0;
    case "workflow_run_reference":
    case "relationship_reference":
    case "file_reference":
      return dialect === "flow" && typeof value === "string" && value.length > 0;
    case "several_choices":
    case "record_reference_list":
    case "relationship_reference_list":
      return (
        dialect === "flow" &&
        Array.isArray(value) &&
        value.every((entry) => typeof entry === "string" && entry.length > 0)
      );
    case "json":
      return jsonValueSchema.safeParse(value).success;
    default:
      return false;
  }
}
export const semanticTypeForLiteral = (value: JsonValue): ConditionValueType | undefined => {
  if (value === null) return undefined;
  if (typeof value === "number") return Number.isSafeInteger(value) ? "whole_number" : undefined;
  if (typeof value === "boolean") return "yes_no";
  if (typeof value === "string") {
    if (validDate(value)) return "date";
    if (flowInstantMicros(value) !== undefined) return "date_time";
    return "text";
  }
  if (recordLinkValueSchema.safeParse(value).success) return "record_reference";
  return Array.isArray(value) && value.every(validText) ? "text_collection" : "opaque_json";
};
export const literalMatchesType = (value: JsonValue, type: ConditionValueType): boolean =>
  value === null ||
  typedValueMatchesType(value, type) ||
  (type === "decimal_number" && typedValueMatchesType(value, "whole_number"));
const exactNumericTypes = new Set<ConditionValueType>(["whole_number", "decimal_number"]);
const numericTypes = exactNumericTypes;
const orderableTypes = new Set<ConditionValueType>([
  "text",
  "whole_number",
  "decimal_number",
  "money",
  "date",
  "date_time",
]);
const unaryOperators = new Set(["is_empty", "is_not_empty"]);

const exactNumericLiteral = (value: JsonValue | undefined): boolean =>
  value === null ||
  (typeof value === "number" && Number.isSafeInteger(value)) ||
  (typeof value === "string" && exactDecimalTextSchema.safeParse(value).success);

const exactNumericOperand = (operand: OperandInfo): boolean =>
  operand.source === "value"
    ? exactNumericLiteral(operand.literal)
    : operand.semanticType !== undefined && exactNumericTypes.has(operand.semanticType);

export const conditionSharedType = (
  left: OperandInfo,
  right: OperandInfo,
): ConditionValueType | undefined => {
  if (
    [left, right].some(
      (operand) =>
        operand.source === "value" &&
        operand.semanticType !== undefined &&
        exactNumericTypes.has(operand.semanticType) &&
        operand.literal !== null &&
        !typedValueMatchesType(operand.literal, operand.semanticType),
    )
  )
    return undefined;
  if (
    left.semanticType &&
    right.semanticType &&
    exactNumericTypes.has(left.semanticType) &&
    exactNumericTypes.has(right.semanticType) &&
    exactNumericOperand(left) &&
    exactNumericOperand(right)
  )
    return left.semanticType === right.semanticType ? left.semanticType : "decimal_number";
  if (left.source === "value" && right.source === "value") {
    if (left.literal === null && right.literal === null) return "opaque_json";
    if (left.literal === null && right.literal !== undefined)
      return right.semanticType ?? semanticTypeForLiteral(right.literal);
    if (right.literal === null && left.literal !== undefined)
      return left.semanticType ?? semanticTypeForLiteral(left.literal);
    return left.semanticType === right.semanticType ? left.semanticType : undefined;
  }

  if (left.source === "reference" && right.source === "reference")
    return left.semanticType === right.semanticType ? left.semanticType : undefined;

  const reference = left.source === "reference" ? left : right;
  const literal = left.source === "value" ? left : right;
  const referenceType = reference.semanticType;
  if (!referenceType || literal.literal === undefined) return undefined;
  if (literalMatchesOperand(literal.literal, reference)) return referenceType;
  return numericTypes.has(referenceType) &&
    exactNumericOperand(reference) &&
    exactNumericOperand(literal)
    ? "decimal_number"
    : undefined;
};

const canBeType = (operand: OperandInfo, type: ConditionValueType): boolean =>
  operand.source === "reference"
    ? operand.semanticType === type
    : operand.literal !== undefined && literalMatchesType(operand.literal, type);

export const isCollectionElementType = (
  type: ConditionValueType | undefined,
): type is Exclude<ConditionValueType, "text_collection" | "opaque_json"> =>
  type !== undefined && type !== "text_collection" && type !== "opaque_json";

export const collectionElementType = (
  operand: OperandInfo,
  expectedType?: ConditionValueType,
): Exclude<ConditionValueType, "text_collection" | "opaque_json"> | undefined => {
  if (operand.source === "reference")
    return operand.semanticType === "text_collection" ? "text" : undefined;
  if (!Array.isArray(operand.literal)) return undefined;
  if (operand.literal.length === 0)
    return isCollectionElementType(expectedType) ? expectedType : undefined;
  if (expectedType && operand.literal.every((value) => literalMatchesType(value, expectedType)))
    return isCollectionElementType(expectedType) ? expectedType : undefined;
  const types = operand.literal.map(semanticTypeForLiteral);
  const firstType = types[0];
  return types.every((type) => type === firstType) && isCollectionElementType(firstType)
    ? firstType
    : undefined;
};

const literalMatchesOperand = (value: JsonValue, reference: OperandInfo): boolean =>
  value === null ||
  (reference.field !== undefined
    ? fieldValueMatches(value, reference.field, reference.dialect ?? "canonical")
    : reference.semanticType !== undefined && literalMatchesType(value, reference.semanticType));

const knownReferenceType = (operand: OperandInfo): ConditionValueType | undefined =>
  operand.source === "reference" ? operand.semanticType : undefined;

export const operatorAcceptsOperands = (
  operator: string,
  left: OperandInfo,
  right: OperandInfo | undefined,
): boolean => {
  if (left.source === "reference" && left.semanticType === undefined) return false;
  if (right?.source === "reference" && right.semanticType === undefined) return false;
  if (unaryOperators.has(operator)) return right === undefined;
  if (!right) return false;

  if (operator === "equals" || operator === "not_equals")
    return conditionSharedType(left, right) !== undefined;
  if (operator === "contains" || operator === "not_contains") {
    if (
      right.source === "reference" &&
      right.field &&
      left.source === "value" &&
      Array.isArray(left.literal)
    )
      return left.literal.every((value) => literalMatchesOperand(value, right));
    const textOperands = canBeType(left, "text") && canBeType(right, "text");
    const elementType = collectionElementType(left, knownReferenceType(right));
    return textOperands || (elementType !== undefined && canBeType(right, elementType));
  }
  if (operator === "in" || operator === "not_in") {
    if (
      left.source === "reference" &&
      left.field &&
      right.source === "value" &&
      Array.isArray(right.literal)
    )
      return (
        isCollectionElementType(left.semanticType) &&
        right.literal.every((value) => literalMatchesOperand(value, left))
      );
    const elementType = collectionElementType(right, knownReferenceType(left));
    return elementType !== undefined && canBeType(left, elementType);
  }
  const type = conditionSharedType(left, right);
  if (
    type === "money" &&
    left.source === "value" &&
    right.source === "value" &&
    left.literal !== null &&
    right.literal !== null
  ) {
    const leftMoney = moneyValueSchema.safeParse(left.literal);
    const rightMoney = moneyValueSchema.safeParse(right.literal);
    if (
      leftMoney.success &&
      rightMoney.success &&
      leftMoney.data.currency !== rightMoney.data.currency
    )
      return false;
  }
  return (
    ["greater_than", "greater_than_or_equal", "less_than", "less_than_or_equal"].includes(
      operator,
    ) &&
    type !== undefined &&
    orderableTypes.has(type)
  );
};

export function fieldValueMatches(
  value: unknown,
  field: Record<string, unknown> | undefined,
  dialect: "source" | "canonical",
): boolean {
  if (!field) return false;
  if (field.type === "calculation" || field.type === "total") {
    const resultType = conditionFieldType(field);
    return resultType !== undefined && typedValueMatchesType(value, resultType, dialect);
  }
  const schemas = dialect === "source" ? sourceModuleFieldValueSchemas : moduleFieldValueSchemas;
  const schema = schemas[String(field.type) as keyof typeof schemas];
  if (schema === undefined || !schema.safeParse(value).success) return false;
  if (
    conditionFieldType(field) === "whole_number" &&
    !typedValueMatchesType(value, "whole_number", dialect)
  )
    return false;
  const expectedRecordTypeIds = fieldRecordTypeIds(field);
  if (expectedRecordTypeIds === undefined) return true;
  const actualRecordTypeId = object(value)[dialect === "source" ? "record_type" : "recordTypeId"];
  return (
    typeof actualRecordTypeId === "string" && expectedRecordTypeIds.includes(actualRecordTypeId)
  );
}

export function fieldRecordTypeIds(
  field: Record<string, unknown> | undefined,
): string[] | undefined {
  if (!field) return undefined;
  const settings = object(field.settings);
  if (field.type === "link")
    return [
      typeof settings.target === "string"
        ? settings.target
        : String(object(settings.target).recordTypeId),
    ];
  if (field.type === "link_to_one_of_several")
    return (Array.isArray(settings.targets) ? settings.targets : []).map((target: unknown) =>
      typeof target === "string" ? target : String(object(target).recordTypeId),
    );
  return undefined;
}
