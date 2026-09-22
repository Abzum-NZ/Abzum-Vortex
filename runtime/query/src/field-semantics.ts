import "server-only";

import {
  compareExactDecimals,
  parseExactDecimal,
  type FieldDefinition,
  type JsonValue,
} from "@vortex/contracts";

/**
 * The comparable/filterable shape a field's runtime value takes, independent of
 * its authored field type. Money is kept separate from plain exact numbers
 * because equality includes currency and cross-currency ordering is refused
 * (docs/specification/10-queries-reports-search.md#exact-field-values-in-queries).
 * `opaque` covers value shapes this Query engine never orders or compares
 * (table, attachment, formatted text): a descriptor that filters or sorts by
 * one is refused rather than guessed at.
 */
export type QuerySemanticType =
  | "text"
  | "text_collection"
  | "number_integer"
  | "number_exact"
  | "money"
  | "boolean"
  | "date"
  | "date_time"
  | "record_reference"
  | "person_reference"
  | "opaque";

export const deriveFieldSemanticType = (field: FieldDefinition): QuerySemanticType => {
  switch (field.type) {
    case "text":
    case "long_text":
    case "reference_number":
    case "email_address":
    case "phone_number":
    case "web_address":
    case "choice":
      return "text";
    case "several_choices":
      return "text_collection";
    case "whole_number":
      return "number_integer";
    case "decimal_number":
      return "number_exact";
    case "money":
      return "money";
    case "yes_no":
      return "boolean";
    case "date":
      return "date";
    case "date_time":
      return "date_time";
    case "link":
    case "link_to_one_of_several":
      return "record_reference";
    case "link_to_person":
      return "person_reference";
    case "formatted_text":
    case "table":
    case "attachment":
      return "opaque";
    case "calculation":
    case "total": {
      switch (field.settings.resultType) {
        case "whole_number":
          return "number_integer";
        case "decimal_number":
          return "number_exact";
        case "money":
          return "money";
        case "yes_no":
          return "boolean";
        case "date":
          return "date";
        case "date_time":
          return "date_time";
        default:
          return "text";
      }
    }
    default:
      return "opaque";
  }
};

const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const isoDateTimePattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Structural check only; canonical field-value contracts remain the source of truth. */
export const valueMatchesSemanticType = (value: JsonValue, type: QuerySemanticType): boolean => {
  if (value === null) return true;
  switch (type) {
    case "text":
      return typeof value === "string";
    case "text_collection":
      return Array.isArray(value) && value.every((entry) => typeof entry === "string");
    case "number_integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "number_exact":
      return typeof value === "string" && parseExactDecimal(value) !== undefined;
    case "money":
      return (
        isPlainRecord(value) &&
        typeof value.amount === "string" &&
        parseExactDecimal(value.amount) !== undefined &&
        typeof value.currency === "string" &&
        /^[A-Z]{3}$/.test(value.currency)
      );
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return typeof value === "string" && isoDatePattern.test(value);
    case "date_time":
      return (
        typeof value === "string" && isoDateTimePattern.test(value) && !Number.isNaN(Date.parse(value))
      );
    case "record_reference":
      return (
        isPlainRecord(value) &&
        typeof value.recordTypeId === "string" &&
        uuidPattern.test(value.recordTypeId) &&
        typeof value.recordId === "string" &&
        uuidPattern.test(value.recordId)
      );
    case "person_reference":
      return (
        isPlainRecord(value) &&
        typeof value.organizationAccountId === "string" &&
        uuidPattern.test(value.organizationAccountId)
      );
    case "opaque":
      return false;
  }
};

export class QueryValueComparisonError extends Error {
  constructor(reason: string) {
    super(`vortex.query.value_comparison_${reason}`);
    this.name = "QueryValueComparisonError";
  }
}

/** Throws for a semantic type this engine never orders (record/person references, collections, opaque). */
export const compareTypedValues = (
  left: JsonValue,
  right: JsonValue,
  type: QuerySemanticType,
): number => {
  if (left === null || right === null) {
    if (left === null && right === null) return 0;
    return left === null ? -1 : 1;
  }
  switch (type) {
    case "text":
      return codePointCompare(left as string, right as string);
    case "number_integer":
      return (left as number) - (right as number);
    case "number_exact": {
      const leftExact = parseExactDecimal(left);
      const rightExact = parseExactDecimal(right);
      if (leftExact === undefined || rightExact === undefined)
        throw new QueryValueComparisonError("exact_decimal_invalid");
      return compareExactDecimals(leftExact, rightExact);
    }
    case "money": {
      const leftMoney = left as { amount: string; currency: string };
      const rightMoney = right as { amount: string; currency: string };
      if (leftMoney.currency !== rightMoney.currency)
        throw new QueryValueComparisonError("money_currency_mismatch");
      const leftExact = parseExactDecimal(leftMoney.amount);
      const rightExact = parseExactDecimal(rightMoney.amount);
      if (leftExact === undefined || rightExact === undefined)
        throw new QueryValueComparisonError("exact_decimal_invalid");
      return compareExactDecimals(leftExact, rightExact);
    }
    case "boolean":
      return (left === right ? 0 : left ? 1 : -1) as number;
    case "date":
      return codePointCompare(left as string, right as string);
    case "date_time": {
      const leftMillis = Date.parse(left as string);
      const rightMillis = Date.parse(right as string);
      if (Number.isNaN(leftMillis) || Number.isNaN(rightMillis))
        throw new QueryValueComparisonError("date_time_invalid");
      return leftMillis - rightMillis;
    }
    case "text_collection":
    case "record_reference":
    case "person_reference":
    case "opaque":
      throw new QueryValueComparisonError("unorderable_type");
  }
};

export const typedValuesEqual = (
  left: JsonValue,
  right: JsonValue,
  type: QuerySemanticType,
): boolean => {
  if (left === null || right === null) return left === right;
  switch (type) {
    case "record_reference": {
      const leftReference = left as { recordTypeId: string; recordId: string };
      const rightReference = right as { recordTypeId: string; recordId: string };
      return (
        leftReference.recordTypeId.toLowerCase() === rightReference.recordTypeId.toLowerCase() &&
        leftReference.recordId.toLowerCase() === rightReference.recordId.toLowerCase()
      );
    }
    case "person_reference": {
      const leftReference = left as { organizationAccountId: string };
      const rightReference = right as { organizationAccountId: string };
      return (
        leftReference.organizationAccountId.toLowerCase() ===
        rightReference.organizationAccountId.toLowerCase()
      );
    }
    case "money": {
      const leftMoney = left as { amount: string; currency: string };
      const rightMoney = right as { amount: string; currency: string };
      if (leftMoney.currency !== rightMoney.currency) return false;
      const leftExact = parseExactDecimal(leftMoney.amount);
      const rightExact = parseExactDecimal(rightMoney.amount);
      return (
        leftExact !== undefined &&
        rightExact !== undefined &&
        compareExactDecimals(leftExact, rightExact) === 0
      );
    }
    case "number_exact": {
      const leftExact = parseExactDecimal(left);
      const rightExact = parseExactDecimal(right);
      return (
        leftExact !== undefined &&
        rightExact !== undefined &&
        compareExactDecimals(leftExact, rightExact) === 0
      );
    }
    case "text_collection":
      return (
        Array.isArray(left) &&
        Array.isArray(right) &&
        left.length === right.length &&
        left.every((entry, index) => entry === right[index])
      );
    case "opaque":
      throw new QueryValueComparisonError("unorderable_type");
    default:
      return compareTypedValues(left, right, type) === 0;
  }
};

export const codePointCompare = (left: string, right: string): number => {
  const leftPoints = [...left].map((entry) => entry.codePointAt(0)!);
  const rightPoints = [...right].map((entry) => entry.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
};
