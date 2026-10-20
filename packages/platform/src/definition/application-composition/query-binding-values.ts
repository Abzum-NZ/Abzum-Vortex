import { z } from "zod";
import { recordIdSchema } from "../../catalogue/identifiers";
import type { JsonValue } from "../../catalogue/common";
import { exactDecimalTextSchema, currencyCodeSchema } from "../../records/module-field-values";
import { normalizeExactDecimal, parseExactDecimal } from "../../records/exact-decimal";

/**
 * The value a binding source gives or a query input needs. A record value names the record types
 * it may be, in the identity space of its caller (qualified references in Studio, record type
 * identities on the server); both sides of one check always use the same space.
 */
export type QueryBindingValueType =
  | Readonly<{
      kind:
        | "text"
        | "formatted_text"
        | "whole_number"
        | "decimal_number"
        | "money"
        | "yes_no"
        | "date"
        | "date_time";
    }>
  | Readonly<{ kind: "record"; recordTypes: readonly string[] }>;

/** The value type of a declared query input, from the input's own type. */
export const queryInputValueType = (
  input: Readonly<{ type: string; recordTypes?: readonly string[] }>,
): QueryBindingValueType | undefined => {
  switch (input.type) {
    case "text":
    case "formatted_text":
    case "whole_number":
    case "decimal_number":
    case "money":
    case "yes_no":
    case "date":
    case "date_time":
      return { kind: input.type };
    case "record_reference":
      return { kind: "record", recordTypes: input.recordTypes ?? [] };
    default:
      return undefined;
  }
};

/**
 * The value type a record field gives a binding, from the field's type. A link names its one target
 * record type; a field whose values no query input can hold gives none.
 */
export const fieldBindingValueType = (
  field: Readonly<{ type: string; linkTargets?: readonly string[]; resultType?: string }>,
): QueryBindingValueType | undefined => {
  const type =
    field.type === "calculation" || field.type === "total" ? field.resultType : field.type;
  switch (type) {
    case "text":
    case "long_text":
    case "choice":
    case "email_address":
    case "phone_number":
    case "web_address":
    case "reference_number":
      return { kind: "text" };
    case "formatted_text":
    case "whole_number":
    case "decimal_number":
    case "money":
    case "yes_no":
    case "date":
    case "date_time":
      return { kind: type };
    case "link":
      return { kind: "record", recordTypes: field.linkTargets ?? [] };
    default:
      return undefined;
  }
};

const typeNames: Readonly<Record<Exclude<QueryBindingValueType["kind"], "record">, string>> = {
  text: "text",
  formatted_text: "formatted text",
  whole_number: "whole number",
  decimal_number: "decimal number",
  money: "money amount",
  yes_no: "yes or no",
  date: "date",
  date_time: "date and time",
};

/** A value type in business words: a record value by its record type's name. */
export const queryBindingTypeName = (
  type: QueryBindingValueType,
  recordTypeLabel: (recordType: string) => string,
): string =>
  type.kind === "record"
    ? type.recordTypes.length === 0
      ? "record"
      : type.recordTypes.map(recordTypeLabel).join(" or ")
    : typeNames[type.kind];

/** "a date", "an Opportunity": the article business sentences put before a type name. */
export const withArticle = (name: string): string =>
  `${/^[aeiou]/i.test(name) ? "an" : "a"} ${name}`;

const sameRecordType = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

/**
 * Whether a source's value fills an input. A record source fills a record input only when it is
 * exactly one record type the input accepts, so the server can build the reference without a
 * guess; a date counted from today fills a date and time input with the start of that day.
 */
export const queryBindingTypesFit = (
  input: QueryBindingValueType,
  source: QueryBindingValueType,
  sourceIsRelativeDate = false,
): boolean => {
  if (input.kind === "record")
    return (
      source.kind === "record" &&
      source.recordTypes.length === 1 &&
      input.recordTypes.some((accepted) => sameRecordType(accepted, source.recordTypes[0]!))
    );
  if (sourceIsRelativeDate) return input.kind === "date" || input.kind === "date_time";
  return input.kind === source.kind;
};

const moneyText = /^([A-Z]{3}) (-?\d+(?:\.\d+)?)$/;
const wholeNumberText = /^-?\d{1,16}$/;

/**
 * Reads one written value (a fixed value or an address value) as the JSON value the Query engine
 * takes for the input type, or undefined when the text is not a value of that type. A record value
 * is a record identity read as the one record type it may be; money is written `NZD 12.50`.
 */
export const parseQueryBindingText = (
  text: string,
  type: QueryBindingValueType,
): JsonValue | undefined => {
  // An empty value is no value: a binding gives one, or the input is left without it.
  if (text === "") return undefined;
  switch (type.kind) {
    case "text":
      return text;
    case "whole_number": {
      const value = Number(text);
      return wholeNumberText.test(text) && Number.isSafeInteger(value) ? value : undefined;
    }
    case "decimal_number": {
      if (parseExactDecimal(text) === undefined) return undefined;
      const normalized = exactDecimalTextSchema.safeParse(normalizeExactDecimal(text));
      return normalized.success ? normalized.data : undefined;
    }
    case "money": {
      const match = moneyText.exec(text);
      if (match === null || !currencyCodeSchema.safeParse(match[1]).success) return undefined;
      const amount = exactDecimalTextSchema.safeParse(normalizeExactDecimal(match[2]!));
      return amount.success ? { amount: amount.data, currency: match[1]! } : undefined;
    }
    case "yes_no":
      return text === "true" ? true : text === "false" ? false : undefined;
    case "date":
      return z.iso.date().safeParse(text).success ? text : undefined;
    case "date_time":
      return z.iso.datetime({ offset: true }).safeParse(text).success ? text : undefined;
    case "record": {
      const recordId = recordIdSchema.safeParse(text);
      return recordId.success && type.recordTypes.length === 1
        ? { recordTypeId: type.recordTypes[0]!, recordId: String(recordId.data) }
        : undefined;
    }
    case "formatted_text":
      return undefined;
  }
};
