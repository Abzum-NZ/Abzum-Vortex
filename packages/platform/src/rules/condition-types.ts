import type { JsonValue } from "../catalogue/common";
import { isStableId } from "../catalogue/stable-id";
import { isMoneyValue, isRecordLinkValue } from "../records/module-field-value-predicates";
import { isCanonicalExactDecimal, currencyCodePattern } from "../records/value-predicates";
import { parseExactDecimal } from "../records/exact-decimal";
import { validText, validDate } from "./typed-condition-core";
import { flowInstantMicros } from "./flow-instant";
import { flowValueMatchesType } from "./flow-value-shapes";

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
  acceptsLiteral?: (value: JsonValue) => boolean;
  dialect?: ValueDialect;
}>;
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
  if (["table", "attachment", "formatted_text", "json"].includes(type)) return "opaque_json";
  return undefined;
}
/**
 * The record fields a placement's condition can compare, by the type of value they hold: a
 * calculation or total by its result type. A plain text, number, money, yes or no, date, date and
 * time or choice field; other kinds (links, tables, attachments) are not offered.
 */
const conditionComparableFieldTypes: ReadonlySet<string> = new Set([
  "text",
  "long_text",
  "choice",
  "whole_number",
  "decimal_number",
  "money",
  "yes_no",
  "date",
  "date_time",
]);
export function comparableConditionFieldType(
  field: { type?: unknown; settings?: unknown } | undefined,
): string | undefined {
  if (!field) return undefined;
  const settings = field.settings as Record<string, unknown> | undefined;
  const type =
    field.type === "calculation" || field.type === "total"
      ? (settings?.resultType ?? settings?.result_type)
      : field.type;
  return typeof type === "string" && conditionComparableFieldTypes.has(type) ? type : undefined;
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
  if (dialect === "flow") return flowValueMatchesType(value, type);
  switch (type) {
    case "decimal_number":
      return dialect === "source"
        ? typeof value === "string" && parseExactDecimal(value) !== undefined
        : isCanonicalExactDecimal(value);
    case "money": {
      if (dialect !== "source") return isMoneyValue(value);
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const money = value as Record<string, unknown>;
      return (
        Object.keys(money).length === 2 &&
        typeof money.amount === "string" &&
        parseExactDecimal(money.amount) !== undefined &&
        typeof money.currency === "string" &&
        currencyCodePattern.test(money.currency)
      );
    }
    case "record_reference":
      if (dialect === "source") {
        const entry = value as Record<string, unknown> | null;
        return (
          entry !== null &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          typeof entry.record_type === "string" &&
          isStableId(entry.record_id)
        );
      }
      return isRecordLinkValue(value);
    case "workflow_run_reference":
    case "relationship_reference":
    case "file_reference":
    case "several_choices":
    case "record_reference_list":
    case "relationship_reference_list":
      return false;
    default:
      return flowValueMatchesType(value, type);
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
  if (isRecordLinkValue(value)) return "record_reference";
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
  (typeof value === "string" && isCanonicalExactDecimal(value));

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
  (reference.acceptsLiteral !== undefined
    ? reference.acceptsLiteral(value)
    : reference.semanticType !== undefined &&
      (literalMatchesType(value, reference.semanticType) ||
        (reference.dialect === "flow" &&
          typedValueMatchesType(value, reference.semanticType, "flow"))));

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
    if (right.source === "reference" && left.source === "value" && Array.isArray(left.literal))
      return left.literal.every((value) => literalMatchesOperand(value, right));
    const textOperands = canBeType(left, "text") && canBeType(right, "text");
    const elementType = collectionElementType(left, knownReferenceType(right));
    return textOperands || (elementType !== undefined && canBeType(right, elementType));
  }
  if (operator === "in" || operator === "not_in") {
    if (left.source === "reference" && right.source === "value" && Array.isArray(right.literal))
      return (
        isCollectionElementType(left.semanticType) &&
        right.literal.every((value) => literalMatchesOperand(value, left))
      );
    const elementType = collectionElementType(right, knownReferenceType(left));
    return elementType !== undefined && canBeType(left, elementType);
  }
  const type = conditionSharedType(left, right);
  return (
    ["greater_than", "greater_than_or_equal", "less_than", "less_than_or_equal"].includes(
      operator,
    ) &&
    type !== undefined &&
    orderableTypes.has(type)
  );
};
