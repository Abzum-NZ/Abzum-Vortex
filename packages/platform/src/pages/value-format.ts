/**
 * The one formatter for money and numbers that pages, boards, summaries and details display.
 * Stored amounts are exact decimal text; Intl formats that text without a float round trip.
 */
const NUMBER_LOCALE = "en";

const decimalFormat = new Intl.NumberFormat(NUMBER_LOCALE, { maximumFractionDigits: 20 });
const moneyFormats = new Map<string, Intl.NumberFormat>();

const moneyFormat = (currency: string): Intl.NumberFormat => {
  let format = moneyFormats.get(currency);
  if (format === undefined) {
    format = new Intl.NumberFormat(NUMBER_LOCALE, { style: "currency", currency });
    moneyFormats.set(currency, format);
  }
  return format;
};

const EXACT_DECIMAL = /^-?\d+(\.\d+)?$/;

/** Whether the text is an exact decimal that `formatDecimal` can group. */
export const isExactDecimal = (text: string): boolean => EXACT_DECIMAL.test(text);

/** A number or exact decimal text with locale digit grouping. */
export const formatDecimal = (value: number | string): string => decimalFormat.format(value as number);

/** A money value with its own currency symbol or code and locale grouping. */
export const formatMoney = (money: Readonly<{ currency: string; amount: string }>): string =>
  moneyFormat(money.currency).format(money.amount as unknown as number);
