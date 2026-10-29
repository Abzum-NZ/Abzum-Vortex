import type { JsonValue } from "../catalogue/common";
import { isRecord } from "../catalogue/runtime-primitives";
import { parseExactDecimal } from "../records/exact-decimal";
import type { FlowRuntimeValue } from "./flow-formula";

const isJsonValue = (value: unknown, ancestors = new Set<object>()): value is JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = (Array.isArray(value) ? value : Object.values(value)).every((item) =>
    isJsonValue(item, ancestors),
  );
  ancestors.delete(value);
  return valid;
};

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
export const flowRuntimeValueOf = (
  type: string,
  value: unknown,
  resultType?: string,
): FlowRuntimeValue => {
  if (type === "calculation" || type === "total") {
    if (resultType === undefined || resultType === "calculation" || resultType === "total")
      throw new Error(`A ${type} field must declare its result type.`);
    return flowRuntimeValueOf(resultType, value);
  }
  const mapped = (flowType: string, accept: (candidate: unknown) => JsonValue | undefined) => {
    if (value === null || value === undefined) return typedValue(flowType, null);
    const accepted = accept(value);
    return accepted === undefined
      ? typedValue("json", isJsonValue(value) ? (value as JsonValue) : null)
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
    case "decimal_number":
      return mapped("decimal_number", (candidate) =>
        typeof candidate === "string" && parseExactDecimal(candidate) !== undefined
          ? candidate
          : undefined,
      );
    case "money":
      return mapped("money", (candidate) =>
        isRecord(candidate) &&
        typeof candidate.amount === "string" &&
        parseExactDecimal(candidate.amount) !== undefined
          ? candidate.amount
          : undefined,
      );
    case "yes_no":
      return mapped("yes_no", (candidate) =>
        typeof candidate === "boolean" ? candidate : undefined,
      );
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
        isRecord(candidate) && typeof candidate.recordId === "string"
          ? candidate.recordId
          : undefined,
      );
    case "organization_account_reference":
      return mapped("organization_account_reference", text);
    default:
      return typedValue(
        "json",
        value !== undefined && isJsonValue(value) ? (value as JsonValue) : null,
      );
  }
};
