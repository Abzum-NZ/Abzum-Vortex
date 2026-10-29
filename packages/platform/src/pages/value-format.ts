import { isIsoCurrencyCode } from "../catalogue/currencies";

/**
 * The one formatter for money and numbers that pages, boards, summaries and details display.
 * Stored amounts are exact decimal text; Intl formats that text without a float round trip.
 */
const NUMBER_LOCALE = "en";

const decimalFormat = new Intl.NumberFormat(NUMBER_LOCALE, { maximumFractionDigits: 20 });
const moneyFormats = new Map<string, Intl.NumberFormat>();

/** Currency punctuation and minor units; exact fraction text is inserted without rounding. */
const moneyFormat = (currency: string, hasFraction: boolean): Intl.NumberFormat => {
  const key = `${currency}:${hasFraction}`;
  let format = moneyFormats.get(key);
  if (format === undefined) {
    const minor =
      new Intl.NumberFormat(NUMBER_LOCALE, { style: "currency", currency }).resolvedOptions()
        .minimumFractionDigits ?? 0;
    format = new Intl.NumberFormat(NUMBER_LOCALE, {
      style: "currency",
      currency,
      minimumFractionDigits: Math.max(minor, hasFraction ? 1 : 0),
    });
    moneyFormats.set(key, format);
  }
  return format;
};

const EXACT_DECIMAL = /^-?\d+(\.\d+)?$/;

/** Whether the text is an exact decimal that `formatDecimal` can group. */
export const isExactDecimal = (text: string): boolean => EXACT_DECIMAL.test(text);

/** A number or exact decimal text with locale digit grouping. */
export const formatDecimal = (value: number | string): string =>
  decimalFormat.format(value as number);

/** A money value with its own currency symbol or code and locale grouping. */
export const formatMoney = (money: Readonly<{ currency: string; amount: string }>): string => {
  const [integer, fraction = ""] = money.amount.split(".");
  const format = moneyFormat(money.currency, fraction.length > 0);
  const minor = format.resolvedOptions().minimumFractionDigits ?? 0;
  // BigInt keeps every integer digit; negative zero preserves the sign of amounts between -1 and 0.
  const whole = integer === "-0" ? -0 : BigInt(integer!);
  return format
    .formatToParts(whole)
    .map((part) => (part.type === "fraction" ? fraction.padEnd(minor, "0") : part.value))
    .join("");
};

/** The formatter names and units a definition may select. */
export const formatterCatalogue = ["number", "money", "percent", "unit"] as const;
export const unitCatalogue = {
  kg: "kg",
  g: "g",
  km: "km",
  m: "m",
  h: "h",
  min: "min",
  items: "items",
} as const;

export type PageFormatter = (typeof formatterCatalogue)[number];
type PageFormatUnit = keyof typeof unitCatalogue;
export type PageFormatValue = string | number | Readonly<{ amount: string; currency: string }>;
export type PageFormatOptions = Readonly<{
  places?: number;
  currency?: string;
  unit?: PageFormatUnit;
}>;

/** Formats a declared value without converting an exact decimal string to a float. */
export const formatPageValue = (
  formatter: PageFormatter,
  input: PageFormatValue,
  options: PageFormatOptions = {},
): string | undefined => {
  const money = typeof input === "object" ? input : undefined;
  const amount = money?.amount ?? input;
  if (
    (typeof amount !== "string" && typeof amount !== "number") ||
    (typeof amount === "number" && !Number.isSafeInteger(amount)) ||
    !isExactDecimal(String(amount)) ||
    (options.places !== undefined &&
      (!Number.isInteger(options.places) || options.places < 0 || options.places > 18))
  )
    return undefined;
  const places = options.places ?? (formatter === "percent" ? 0 : undefined);
  if (formatter === "money") {
    const currency = money?.currency ?? options.currency;
    if (currency === undefined || !isIsoCurrencyCode(currency)) return undefined;
    // Without explicit places the stored amount is shown exactly, padded to the currency's minor
    // units: one money display for cells, boards and summaries.
    if (options.places === undefined && typeof amount === "string")
      return formatMoney({ currency, amount });
    return new Intl.NumberFormat(NUMBER_LOCALE, {
      style: "currency",
      currency,
      minimumFractionDigits: options.places,
      maximumFractionDigits: options.places,
    }).format(amount as number);
  }
  if (money !== undefined) return undefined;
  if (
    formatter === "unit" &&
    (options.unit === undefined || !Object.hasOwn(unitCatalogue, options.unit))
  )
    return undefined;
  const formatted =
    places === undefined
      ? formatDecimal(amount)
      : new Intl.NumberFormat(NUMBER_LOCALE, {
          minimumFractionDigits: places,
          maximumFractionDigits: places,
        }).format(amount as number);
  return formatter === "percent"
    ? `${formatted}%`
    : formatter === "unit"
      ? `${formatted} ${unitCatalogue[options.unit!]}`
      : formatted;
};
