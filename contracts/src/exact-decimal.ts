declare const exactDecimalBrand: unique symbol;

/**
 * An exact base-10 value for internal comparison and validation.
 *
 * Persisted and transported values use {@link formatExactDecimal}; BigInt is not
 * part of a JSON contract.
 */
export type ExactDecimal = Readonly<{
  coefficient: bigint;
  scale: number;
  readonly [exactDecimalBrand]: true;
}>;

export type ExactDecimalDigitCounts = Readonly<{
  digitsBeforeDecimal: number;
  decimalPlaces: number;
}>;

const exactDecimalPattern = /^-?(0|[1-9]\d*)(?:\.(\d+))?$/;

const exactDecimal = (coefficient: bigint, scale: number): ExactDecimal =>
  Object.freeze({ coefficient, scale }) as ExactDecimal;

/** Parses and normalizes exact base-10 text without using a JavaScript number. */
export const parseExactDecimal = (value: unknown): ExactDecimal | undefined => {
  if (typeof value !== "string") return undefined;

  const match = exactDecimalPattern.exec(value);
  if (!match) return undefined;

  const integer = match[1]!;
  const fraction = match[2] ?? "";
  let coefficient = BigInt(`${integer}${fraction}`);
  let scale = fraction.length;

  if (value.startsWith("-") && coefficient !== 0n) coefficient = -coefficient;
  if (coefficient === 0n) return exactDecimal(0n, 0);

  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }

  return exactDecimal(coefficient, scale);
};

/** Formats a parsed value as its canonical exact base-10 transport text. */
export const formatExactDecimal = (value: ExactDecimal): string => {
  if (value.coefficient === 0n) return "0";

  const negative = value.coefficient < 0n;
  const digits = (negative ? -value.coefficient : value.coefficient).toString();
  let magnitude: string;

  if (value.scale === 0) {
    magnitude = digits;
  } else if (digits.length <= value.scale) {
    magnitude = `0.${"0".repeat(value.scale - digits.length)}${digits}`;
  } else {
    const decimalIndex = digits.length - value.scale;
    magnitude = `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  }

  return negative ? `-${magnitude}` : magnitude;
};

/** Parses exact decimal text and returns canonical text when valid. */
export const normalizeExactDecimal = (value: unknown): string | undefined => {
  const parsed = parseExactDecimal(value);
  return parsed === undefined ? undefined : formatExactDecimal(parsed);
};

const powerOfTen = (exponent: number): bigint => 10n ** BigInt(exponent);

/** Compares two parsed values exactly, including values with different scales. */
export const compareExactDecimals = (left: ExactDecimal, right: ExactDecimal): -1 | 0 | 1 => {
  const commonScale = Math.max(left.scale, right.scale);
  const leftCoefficient = left.coefficient * powerOfTen(commonScale - left.scale);
  const rightCoefficient = right.coefficient * powerOfTen(commonScale - right.scale);

  if (leftCoefficient < rightCoefficient) return -1;
  if (leftCoefficient > rightCoefficient) return 1;
  return 0;
};

/** Returns digit counts for the normalized value, excluding its sign. */
export const exactDecimalDigitCounts = (value: ExactDecimal): ExactDecimalDigitCounts => {
  const magnitude = value.coefficient < 0n ? -value.coefficient : value.coefficient;
  const coefficientDigits = magnitude.toString().length;

  return {
    digitsBeforeDecimal: Math.max(1, coefficientDigits - value.scale),
    decimalPlaces: value.scale,
  };
};
