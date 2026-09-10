import { normalizeExactDecimal, parseExactDecimal } from "@vortex/contracts";

export type ExactRational = Readonly<{
  numerator: bigint;
  denominator: bigint;
}>;

const magnitude = (value: bigint): bigint => (value < 0n ? -value : value);

const greatestCommonDivisor = (left: bigint, right: bigint): bigint => {
  let a = magnitude(left);
  let b = magnitude(right);
  while (b !== 0n) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
};

const rational = (numerator: bigint, denominator: bigint): ExactRational | undefined => {
  if (denominator === 0n) return undefined;
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = greatestCommonDivisor(numerator, denominator);
  return {
    numerator: (numerator * sign) / divisor,
    denominator: magnitude(denominator) / divisor,
  };
};

export const rationalFromExactText = (value: unknown): ExactRational | undefined => {
  const parsed = parseExactDecimal(value);
  return parsed === undefined
    ? undefined
    : rational(parsed.coefficient, 10n ** BigInt(parsed.scale));
};

export const rationalFromWholeNumber = (value: unknown): ExactRational | undefined =>
  typeof value === "number" && Number.isSafeInteger(value)
    ? rational(BigInt(value), 1n)
    : undefined;

export const addRationals = (left: ExactRational, right: ExactRational): ExactRational =>
  rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  )!;

export const subtractRationals = (left: ExactRational, right: ExactRational): ExactRational =>
  rational(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator,
  )!;

export const multiplyRationals = (left: ExactRational, right: ExactRational): ExactRational =>
  rational(left.numerator * right.numerator, left.denominator * right.denominator)!;

export const divideRationals = (
  left: ExactRational,
  right: ExactRational,
): ExactRational | undefined =>
  right.numerator === 0n
    ? undefined
    : rational(left.numerator * right.denominator, left.denominator * right.numerator);

export const compareRationals = (left: ExactRational, right: ExactRational): number => {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
};

const normalizedText = (coefficient: bigint, scale: number): string => {
  const negative = coefficient < 0n;
  const digits = magnitude(coefficient)
    .toString()
    .padStart(scale + 1, "0");
  const text =
    scale === 0
      ? digits
      : `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;
  return normalizeExactDecimal(`${negative ? "-" : ""}${text}`)!;
};

export const rationalToExactText = (value: ExactRational): string | undefined => {
  let denominator = value.denominator;
  let twos = 0;
  let fives = 0;
  while (denominator % 2n === 0n) {
    denominator /= 2n;
    twos += 1;
  }
  while (denominator % 5n === 0n) {
    denominator /= 5n;
    fives += 1;
  }
  if (denominator !== 1n) return undefined;
  const scale = Math.max(twos, fives);
  const coefficient = value.numerator * 2n ** BigInt(scale - twos) * 5n ** BigInt(scale - fives);
  return normalizedText(coefficient, scale);
};

export const roundRationalHalfEven = (
  value: ExactRational,
  decimalPlaces: number,
): string | undefined => {
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 12) return undefined;
  const scaledNumerator = value.numerator * 10n ** BigInt(decimalPlaces);
  let coefficient = scaledNumerator / value.denominator;
  const remainder = magnitude(scaledNumerator % value.denominator);
  const comparison = remainder * 2n - value.denominator;
  if (comparison > 0n || (comparison === 0n && magnitude(coefficient) % 2n === 1n))
    coefficient += scaledNumerator < 0n ? -1n : 1n;
  return normalizedText(coefficient, decimalPlaces);
};

export const rationalToSafeWholeNumber = (value: ExactRational): number | undefined => {
  if (value.numerator % value.denominator !== 0n) return undefined;
  const integer = value.numerator / value.denominator;
  if (integer < BigInt(Number.MIN_SAFE_INTEGER) || integer > BigInt(Number.MAX_SAFE_INTEGER))
    return undefined;
  return Number(integer);
};
