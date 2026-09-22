import "server-only";

import {
  compareExactDecimals,
  parseExactDecimal,
  recordRichTextDocumentV2Schema,
  type ActionInputDefinitionV2,
  type JsonValue,
} from "@vortex/contracts";

export const queryInputRefusalReasons = [
  "input_unknown",
  "input_missing",
  "input_type_invalid",
  "input_range_invalid",
] as const;
export type QueryInputRefusalReason = (typeof queryInputRefusalReasons)[number];

export class QueryInputRefusalError extends Error {
  constructor(
    readonly reason: QueryInputRefusalReason,
    readonly key?: string,
  ) {
    super(`vortex.query.input_${reason}`);
    this.name = "QueryInputRefusalError";
  }
}

const refuse = (reason: QueryInputRefusalReason, key?: string): never => {
  throw new QueryInputRefusalError(reason, key);
};

const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates and canonicalizes caller-supplied typed input values against the
 * exact input contract a published Module query declares. Refuses the whole
 * request on the first unknown, missing, mistyped or out-of-range input
 * rather than coercing or dropping it.
 */
export const validateQueryInputValues = (
  inputs: readonly ActionInputDefinitionV2[],
  suppliedValues: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> => {
  const declaredKeys = new Set(inputs.map((input) => input.key));
  for (const key of Object.keys(suppliedValues)) if (!declaredKeys.has(key)) refuse("input_unknown", key);

  const canonical: Record<string, JsonValue> = {};
  for (const input of inputs) {
    const hasValue = Object.prototype.hasOwnProperty.call(suppliedValues, input.key);
    if (!hasValue) {
      if (input.required) refuse("input_missing", input.key);
      continue;
    }
    const value = suppliedValues[input.key]!;
    if (value === null) {
      if (input.required) refuse("input_missing", input.key);
      canonical[input.key] = null;
      continue;
    }
    canonical[input.key] = validateOne(input, value);
  }
  return canonical;
};

const validateOne = (input: ActionInputDefinitionV2, value: JsonValue): JsonValue => {
  switch (input.type) {
    case "text": {
      if (typeof value !== "string") refuse("input_type_invalid", input.key);
      if (input.validation?.minimumLength !== undefined && value.length < input.validation.minimumLength)
        refuse("input_range_invalid", input.key);
      if (input.validation?.maximumLength !== undefined && value.length > input.validation.maximumLength)
        refuse("input_range_invalid", input.key);
      if (input.validation?.pattern !== undefined && !new RegExp(input.validation.pattern).test(value))
        refuse("input_range_invalid", input.key);
      return value;
    }
    case "formatted_text": {
      const parsed = recordRichTextDocumentV2Schema.safeParse(value);
      if (!parsed.success) refuse("input_type_invalid", input.key);
      return value;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) refuse("input_type_invalid", input.key);
      if (input.validation?.minimum !== undefined && value < input.validation.minimum)
        refuse("input_range_invalid", input.key);
      if (input.validation?.maximum !== undefined && value > input.validation.maximum)
        refuse("input_range_invalid", input.key);
      return value;
    }
    case "decimal_number":
    case "money": {
      const amount = input.type === "money" ? (isPlainRecord(value) ? value.amount : undefined) : value;
      const currency = input.type === "money" ? (isPlainRecord(value) ? value.currency : undefined) : undefined;
      if (input.type === "money" && (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)))
        refuse("input_type_invalid", input.key);
      const exact = typeof amount === "string" ? parseExactDecimal(amount) : undefined;
      if (exact === undefined) refuse("input_type_invalid", input.key);
      if (input.validation?.minimum !== undefined) {
        const minimum = parseExactDecimal(input.validation.minimum);
        if (minimum !== undefined && compareExactDecimals(exact!, minimum) < 0)
          refuse("input_range_invalid", input.key);
      }
      if (input.validation?.maximum !== undefined) {
        const maximum = parseExactDecimal(input.validation.maximum);
        if (maximum !== undefined && compareExactDecimals(exact!, maximum) > 0)
          refuse("input_range_invalid", input.key);
      }
      return value;
    }
    case "boolean": {
      if (typeof value !== "boolean") refuse("input_type_invalid", input.key);
      return value;
    }
    case "date": {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
        refuse("input_type_invalid", input.key);
      if (input.validation?.earliest !== undefined && value < input.validation.earliest)
        refuse("input_range_invalid", input.key);
      if (input.validation?.latest !== undefined && value > input.validation.latest)
        refuse("input_range_invalid", input.key);
      return value;
    }
    case "date_time": {
      if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
        refuse("input_type_invalid", input.key);
      if (
        input.validation?.earliest !== undefined &&
        Date.parse(value) < Date.parse(input.validation.earliest)
      )
        refuse("input_range_invalid", input.key);
      if (
        input.validation?.latest !== undefined &&
        Date.parse(value) > Date.parse(input.validation.latest)
      )
        refuse("input_range_invalid", input.key);
      return value;
    }
    case "record_reference": {
      if (!isPlainRecord(value)) refuse("input_type_invalid", input.key);
      const record = value as Readonly<Record<string, unknown>>;
      const recordTypeId = record.recordTypeId;
      const recordId = record.recordId;
      if (
        typeof recordTypeId !== "string" ||
        !uuidPattern.test(recordTypeId) ||
        typeof recordId !== "string" ||
        !uuidPattern.test(recordId)
      )
        refuse("input_type_invalid", input.key);
      const allowed = input.recordTypes.some(
        (candidate) =>
          candidate.state === "resolved" &&
          candidate.recordTypeId.toLowerCase() === (recordTypeId as string).toLowerCase(),
      );
      if (!allowed) refuse("input_type_invalid", input.key);
      return value;
    }
    case "organization_account_reference": {
      if (!isPlainRecord(value)) refuse("input_type_invalid", input.key);
      const organizationAccountId = (value as Readonly<Record<string, unknown>>).organizationAccountId;
      if (typeof organizationAccountId !== "string" || !uuidPattern.test(organizationAccountId))
        refuse("input_type_invalid", input.key);
      return value;
    }
  }
};
