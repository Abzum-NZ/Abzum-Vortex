/**
 * The one formatter for money and numbers that pages, boards, summaries and details display.
 * Stored amounts are exact decimal text; Intl formats that text without a float round trip.
 */
const NUMBER_LOCALE = "en";

const decimalFormat = new Intl.NumberFormat(NUMBER_LOCALE, { maximumFractionDigits: 20 });
const moneyFormats = new Map<string, Intl.NumberFormat>();

/**
 * A currency's formatter showing at least the currency's own minor units and, for an amount
 * stored with more decimal places, every one of them: a stored amount is never rounded on screen.
 */
const moneyFormat = (currency: string, decimalPlaces: number): Intl.NumberFormat => {
  const key = `${currency}:${decimalPlaces}`;
  let format = moneyFormats.get(key);
  if (format === undefined) {
    const minor =
      new Intl.NumberFormat(NUMBER_LOCALE, { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
    format = new Intl.NumberFormat(NUMBER_LOCALE, {
      style: "currency",
      currency,
      minimumFractionDigits: minor,
      maximumFractionDigits: Math.min(20, Math.max(minor, decimalPlaces)),
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
export const formatMoney = (money: Readonly<{ currency: string; amount: string }>): string =>
  moneyFormat(money.currency, money.amount.split(".")[1]?.length ?? 0).format(
    money.amount as unknown as number,
  );
