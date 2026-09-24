import "server-only";

import { z } from "zod";
import {
  actionInputDefinitionV2Schema,
  compareExactDecimals,
  compileTextInputPattern,
  normalizeExactDecimal,
  parseExactDecimal,
  recordRichTextDocumentV2Schema,
  type ActionInputDefinitionV2,
  type JsonValue,
} from "@vortex/contracts";

export class QueryInputRefusalError extends Error {
  constructor() {
    super("vortex.query.input_invalid");
    this.name = "QueryInputRefusalError";
  }
}

const refuse = (): never => {
  throw new QueryInputRefusalError();
};

const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasExactKeys = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });

const inputDeclarationsSchema = z.array(actionInputDefinitionV2Schema).max(50);

/** Parses the installed input contract the database returned; a malformed one is not guessed at. */
export const parseQueryInputDeclarations = (
  candidate: unknown,
): readonly ActionInputDefinitionV2[] | undefined => {
  const parsed = inputDeclarationsSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
};

/**
 * Validates caller-supplied values against the exact input contract of the
 * installed query and returns them in canonical form (exact decimal text). The
 * whole request is refused on the first unknown, missing,
 * mistyped or out-of-range value; nothing is coerced or dropped. The database
 * reader checks the same values again against the condition engine's types.
 */
export const validateQueryInputValues = (
  inputs: readonly ActionInputDefinitionV2[],
  suppliedValues: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> => {
  const declaredKeys = new Set(inputs.map((input) => input.key));
  for (const key of Object.keys(suppliedValues)) if (!declaredKeys.has(key)) refuse();

  const canonical: Record<string, JsonValue> = {};
  for (const input of inputs) {
    const value = Object.prototype.hasOwnProperty.call(suppliedValues, input.key)
      ? suppliedValues[input.key]!
      : null;
    if (value === null) {
      if (input.required) refuse();
      continue;
    }
    canonical[input.key] = validateOne(input, value);
  }
  return canonical;
};

const exactWithinRange = (
  amount: unknown,
  validation: Readonly<{ minimum?: string | undefined; maximum?: string | undefined }> | undefined,
): string => {
  if (typeof amount !== "string") return refuse();
  const normalized = normalizeExactDecimal(amount);
  const exact = parseExactDecimal(amount);
  if (normalized === undefined || exact === undefined) return refuse();
  const minimum = validation?.minimum === undefined ? undefined : parseExactDecimal(validation.minimum);
  const maximum = validation?.maximum === undefined ? undefined : parseExactDecimal(validation.maximum);
  if (minimum !== undefined && compareExactDecimals(exact, minimum) < 0) refuse();
  if (maximum !== undefined && compareExactDecimals(exact, maximum) > 0) refuse();
  return normalized;
};

const validateOne = (input: ActionInputDefinitionV2, value: JsonValue): JsonValue => {
  switch (input.type) {
    case "text": {
      if (typeof value !== "string") return refuse();
      const validation = input.validation;
      if (validation?.minimumLength !== undefined && value.length < validation.minimumLength) refuse();
      if (validation?.maximumLength !== undefined && value.length > validation.maximumLength) refuse();
      if (validation?.pattern !== undefined) {
        const pattern = compileTextInputPattern(validation.pattern);
        if (pattern === undefined) return refuse();
        if (!pattern.test(value)) refuse();
      }
      return value;
    }
    case "formatted_text":
      return recordRichTextDocumentV2Schema.safeParse(value).success ? value : refuse();
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return refuse();
      if (input.validation?.minimum !== undefined && value < input.validation.minimum) refuse();
      if (input.validation?.maximum !== undefined && value > input.validation.maximum) refuse();
      return value;
    }
    case "decimal_number":
      return exactWithinRange(value, input.validation);
    case "money": {
      if (!isPlainRecord(value) || !hasExactKeys(value, ["amount", "currency"])) return refuse();
      if (typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency)) return refuse();
      return { amount: exactWithinRange(value.amount, input.validation), currency: value.currency };
    }
    case "boolean":
      return typeof value === "boolean" ? value : refuse();
    case "date": {
      if (typeof value !== "string" || !isoDate.safeParse(value).success) return refuse();
      if (input.validation?.earliest !== undefined && value < input.validation.earliest) refuse();
      if (input.validation?.latest !== undefined && value > input.validation.latest) refuse();
      return value;
    }
    case "date_time": {
      if (typeof value !== "string" || !isoDateTime.safeParse(value).success) return refuse();
      const instant = Date.parse(value);
      if (Number.isNaN(instant)) return refuse();
      if (input.validation?.earliest !== undefined && instant < Date.parse(input.validation.earliest))
        refuse();
      if (input.validation?.latest !== undefined && instant > Date.parse(input.validation.latest))
        refuse();
      return value;
    }
    case "record_reference": {
      if (!isPlainRecord(value) || !hasExactKeys(value, ["recordTypeId", "recordId"])) return refuse();
      const { recordTypeId, recordId } = value;
      if (
        typeof recordTypeId !== "string" ||
        !uuidPattern.test(recordTypeId) ||
        typeof recordId !== "string" ||
        !uuidPattern.test(recordId)
      )
        return refuse();
      const allowed = input.recordTypes.some(
        (candidate) =>
          candidate.state === "resolved" &&
          candidate.recordTypeId.toLowerCase() === recordTypeId.toLowerCase(),
      );
      return allowed ? { recordTypeId, recordId } : refuse();
    }
    case "organization_account_reference": {
      if (!isPlainRecord(value) || !hasExactKeys(value, ["organizationAccountId"])) return refuse();
      const { organizationAccountId } = value;
      if (typeof organizationAccountId !== "string" || !uuidPattern.test(organizationAccountId))
        return refuse();
      return { organizationAccountId };
    }
  }
};
