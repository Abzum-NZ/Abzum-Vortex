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
