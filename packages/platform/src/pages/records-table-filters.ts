/**
 * The typed column filter of a Records table: one filter per field, whose kind follows the field's
 * canonical type (never its display format). It is isomorphic: the browser builds it from a
 * filter control, the page address carries its spelling, and the server validates it against the
 * installed field before it builds a Query condition from it.
 */
import {
  compareExactDecimals,
  normalizeExactDecimal,
  parseExactDecimal,
} from "../records/exact-decimal";

/** The longest text filter, and the most values a choice filter and records a link filter name. */
export const RECORDS_TABLE_MAXIMUM_FILTER_TEXT_LENGTH = 200;
export const RECORDS_TABLE_MAXIMUM_FILTER_CHOICES = 50;
export const RECORDS_TABLE_MAXIMUM_FILTER_RECORDS = 20;

/**
 * One field's filter, typed by its kind. Range bounds are optional (an open end) and inclusive;
 * number and money bounds are exact decimal text, never floating point; date bounds are calendar
 * days (`YYYY-MM-DD`). A money range names its currency. A choice or link filter matches any one of
 * its values.
 */
export type RecordsTableFieldFilter =
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "choice"; values: readonly string[] }>
  | Readonly<{ kind: "number"; from?: string; to?: string }>
  | Readonly<{ kind: "money"; currency: string; from?: string; to?: string }>
  | Readonly<{ kind: "date"; from?: string; to?: string }>
  | Readonly<{ kind: "link"; recordIds: readonly string[] }>
  | Readonly<{ kind: "yes_no"; value: boolean }>;

/** One active filter: the filterable field and its typed filter. */
export type RecordsTableFilterValue = Readonly<{
  fieldId: string;
  filter: RecordsTableFieldFilter;
}>;

const DECIMAL_PATTERN = /^(-?)([0-9]{1,30})(?:\.([0-9]{1,20}))?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const CALENDAR_DAY_PATTERN = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const RECORD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Exact decimal text in its canonical spelling (no leading or trailing zeros, no negative zero). */
export const canonicalRecordsTableDecimal = (raw: string): string | undefined => {
  const match = DECIMAL_PATTERN.exec(raw.trim());
  if (match === null) return undefined;
  const whole = (match[2] ?? "").replace(/^0+(?=[0-9])/, "");
  const fraction = match[3];
  return normalizeExactDecimal(
    `${match[1]}${whole}${fraction === undefined ? "" : `.${fraction}`}`,
  );
};

/** Compares two canonical decimals exactly: negative, zero or positive. */
export const compareRecordsTableDecimals = (left: string, right: string): number => {
  const first = parseExactDecimal(left);
  const second = parseExactDecimal(right);
  if (first === undefined || second === undefined)
    throw new Error("A filter comparison requires canonical decimal bounds");
  return compareExactDecimals(first, second);
};

/** Whether text is a real calendar day, `YYYY-MM-DD`. */
export const isRecordsTableCalendarDay = (raw: string): boolean => {
  const match = CALENDAR_DAY_PATTERN.exec(raw);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(0, 0, 0, 0);
  return (
    year >= 1 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month &&
    date.getUTCDate() === day
  );
};

type Bound = string | undefined | false;

const bounds = (from: string | undefined, to: string | undefined) => ({
  ...(from === undefined ? {} : { from }),
  ...(to === undefined ? {} : { to }),
});

/**
 * The one validator of a typed filter: it returns the filter in canonical form, or undefined when
 * any part is malformed, a range is inverted or open on both ends, or a list is empty, repeated or
 * too long. The address codec, the payload parser and the server all read filters through it.
 */
export const readRecordsTableFieldFilter = (
  value: unknown,
): RecordsTableFieldFilter | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const only = (...allowed: string[]): boolean =>
    Object.keys(record).every((key) => allowed.includes(key));
  const text = (key: string): Bound => {
    const held = record[key];
    return held === undefined ? undefined : typeof held === "string" ? held : false;
  };
  const decimal = (key: string): Bound => {
    const held = text(key);
    return held === false || held === undefined
      ? held
      : (canonicalRecordsTableDecimal(held) ?? false);
  };
  const day = (key: string): Bound => {
    const held = text(key);
    return held === false || held === undefined || isRecordsTableCalendarDay(held) ? held : false;
  };
  const list = (held: unknown, maximum: number, item: (entry: string) => boolean) =>
    Array.isArray(held) &&
    held.length > 0 &&
    held.length <= maximum &&
    held.every((entry) => typeof entry === "string" && item(entry)) &&
    new Set(held.map((entry: string) => (record.kind === "link" ? entry.toLowerCase() : entry)))
      .size === held.length
      ? (held as string[])
      : undefined;
  switch (record.kind) {
    case "empty":
      return only("kind") ? { kind: "empty" } : undefined;
    case "text": {
      const held = typeof record.text === "string" ? record.text.trim() : "";
      return only("kind", "text") &&
        held !== "" &&
        held.length <= RECORDS_TABLE_MAXIMUM_FILTER_TEXT_LENGTH
        ? { kind: "text", text: held }
        : undefined;
    }
    case "choice": {
      const values = list(
        record.values,
        RECORDS_TABLE_MAXIMUM_FILTER_CHOICES,
        (entry) => entry !== "" && entry.length <= 120,
      );
      return only("kind", "values") && values !== undefined
        ? { kind: "choice", values: [...values] }
        : undefined;
    }
    case "number":
    case "money": {
      const from = decimal("from");
      const to = decimal("to");
      if (from === false || to === false || (from === undefined && to === undefined))
        return undefined;
      if (from !== undefined && to !== undefined && compareRecordsTableDecimals(from, to) > 0)
        return undefined;
      if (record.kind === "number")
        return only("kind", "from", "to") ? { kind: "number", ...bounds(from, to) } : undefined;
      return only("kind", "currency", "from", "to") &&
        typeof record.currency === "string" &&
        CURRENCY_PATTERN.test(record.currency)
        ? { kind: "money", currency: record.currency, ...bounds(from, to) }
        : undefined;
    }
    case "date": {
      const from = day("from");
      const to = day("to");
      if (from === false || to === false || (from === undefined && to === undefined))
        return undefined;
      return only("kind", "from", "to") && (from === undefined || to === undefined || from <= to)
        ? { kind: "date", ...bounds(from, to) }
        : undefined;
    }
    case "link": {
      const recordIds = list(record.recordIds, RECORDS_TABLE_MAXIMUM_FILTER_RECORDS, (entry) =>
        RECORD_ID_PATTERN.test(entry),
      );
      return only("kind", "recordIds") && recordIds !== undefined
        ? { kind: "link", recordIds: recordIds.map((id) => id.toLowerCase()) }
        : undefined;
    }
    case "yes_no":
      return only("kind", "value") && typeof record.value === "boolean"
        ? { kind: "yes_no", value: record.value }
        : undefined;
    default:
      return undefined;
  }
};

const encodeList = (values: readonly string[]): string =>
  values.map((value) => encodeURIComponent(value)).join(",");

const encodeRange = (from: string | undefined, to: string | undefined): string =>
  `${from ?? ""}..${to ?? ""}`;

/**
 * The address spelling of a typed filter, `<kind>:<operand>`, which the address then encodes. Text
 * is kept as typed; a list is comma-separated with each value URI-encoded; a range is
 * `<from>..<to>` with either end empty; money is `<currency>:<from>..<to>`. A filter control reports
 * this spelling in its `filter_changed` event, and an empty spelling clears the field's filter.
 */
export const encodeRecordsTableFieldFilter = (filter: RecordsTableFieldFilter): string => {
  switch (filter.kind) {
    case "empty":
      return "empty:";
    case "text":
      return `text:${filter.text}`;
    case "choice":
      return `choice:${encodeList(filter.values)}`;
    case "number":
    case "date":
      return `${filter.kind}:${encodeRange(filter.from, filter.to)}`;
    case "money":
      return `money:${filter.currency}:${encodeRange(filter.from, filter.to)}`;
    case "link":
      return `link:${filter.recordIds.join(",")}`;
    case "yes_no":
      return `yes_no:${String(filter.value)}`;
  }
};

/** Reads an address spelling back into a validated typed filter; undefined when it is malformed. */
export const decodeRecordsTableFieldFilter = (
  spelled: string,
): RecordsTableFieldFilter | undefined => {
  const separator = spelled.indexOf(":");
  if (separator < 1) return undefined;
  const kind = spelled.slice(0, separator);
  const operand = spelled.slice(separator + 1);
  const range = (text: string): Readonly<{ from?: string; to?: string }> | undefined => {
    const parts = text.split("..");
    if (parts.length !== 2) return undefined;
    const [from = "", to = ""] = parts;
    return bounds(from === "" ? undefined : from, to === "" ? undefined : to);
  };
  const list = (text: string): string[] | undefined => {
    try {
      return text.split(",").map((value) => decodeURIComponent(value));
      // guard-allow: silent-catch Malformed percent-encoding in an address parameter is refused as invalid input.
    } catch {
      return undefined;
    }
  };
  switch (kind) {
    case "empty":
      return operand === "" ? { kind: "empty" } : undefined;
    case "text":
      return readRecordsTableFieldFilter({ kind, text: operand });
    case "choice": {
      const values = list(operand);
      return values === undefined ? undefined : readRecordsTableFieldFilter({ kind, values });
    }
    case "number":
    case "date": {
      const read = range(operand);
      return read === undefined ? undefined : readRecordsTableFieldFilter({ kind, ...read });
    }
    case "money": {
      const currencyEnd = operand.indexOf(":");
      const read = currencyEnd < 0 ? undefined : range(operand.slice(currencyEnd + 1));
      return read === undefined
        ? undefined
        : readRecordsTableFieldFilter({ kind, currency: operand.slice(0, currencyEnd), ...read });
    }
    case "link":
      return readRecordsTableFieldFilter({ kind, recordIds: operand.split(",") });
    case "yes_no":
      return operand === "true" || operand === "false"
        ? { kind: "yes_no", value: operand === "true" }
        : undefined;
    default:
      return undefined;
  }
};
