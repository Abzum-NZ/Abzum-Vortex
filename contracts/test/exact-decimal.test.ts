import { describe, expect, test } from "vitest";
import {
  compareExactDecimals,
  exactDecimalDigitCounts,
  formatExactDecimal,
  normalizeExactDecimal,
  parseExactDecimal,
  type ExactDecimal,
} from "../src/exact-decimal.js";

const parsed = (value: string): ExactDecimal => {
  const result = parseExactDecimal(value);
  if (result === undefined) throw new Error(`Expected a valid exact decimal: ${value}`);
  return result;
};

describe("exact decimal", () => {
  test.each([
    ["0", 0n, 0, "0"],
    ["-0.000", 0n, 0, "0"],
    ["42", 42n, 0, "42"],
    ["-12.3400", -1234n, 2, "-12.34"],
    ["0.0012300", 123n, 5, "0.00123"],
    [
      "90071992547409931234567890.1200",
      9007199254740993123456789012n,
      2,
      "90071992547409931234567890.12",
    ],
  ])("parses and normalizes %s", (input, coefficient, scale, normalized) => {
    const value = parseExactDecimal(input);

    expect(value).toMatchObject({ coefficient, scale });
    expect(value && formatExactDecimal(value)).toBe(normalized);
    expect(normalizeExactDecimal(input)).toBe(normalized);
  });

  test.each([
    "",
    "-",
    "+1",
    " 1",
    "1 ",
    "01",
    "-01",
    "00",
    ".5",
    "1.",
    "1e3",
    "1E3",
    "NaN",
    "Infinity",
    "-Infinity",
    "--1",
    "1..2",
  ])("refuses invalid decimal syntax %j", (input) => {
    expect(parseExactDecimal(input)).toBeUndefined();
    expect(normalizeExactDecimal(input)).toBeUndefined();
  });

  test.each([1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, true, {}])(
    "refuses non-string input %j",
    (input) => {
      expect(parseExactDecimal(input)).toBeUndefined();
      expect(normalizeExactDecimal(input)).toBeUndefined();
    },
  );

  test.each([
    ["0", "-0.00", 0],
    ["1.2", "1.20", 0],
    ["1.02", "1.2", -1],
    ["-1.2", "-1.21", 1],
    ["0.00000000000000000001", "0", 1],
    ["90071992547409931234567890.12", "90071992547409931234567890.11", 1],
    ["-90071992547409931234567890.12", "-90071992547409931234567890.11", -1],
  ] as const)("compares %s with %s exactly", (left, right, expected) => {
    expect(compareExactDecimals(parsed(left), parsed(right))).toBe(expected);
  });

  test.each([
    ["0", { digitsBeforeDecimal: 1, decimalPlaces: 0 }],
    ["123", { digitsBeforeDecimal: 3, decimalPlaces: 0 }],
    ["-123.4500", { digitsBeforeDecimal: 3, decimalPlaces: 2 }],
    ["0.0012300", { digitsBeforeDecimal: 1, decimalPlaces: 5 }],
    ["90071992547409931234567890.1200", { digitsBeforeDecimal: 26, decimalPlaces: 2 }],
  ])("reports normalized digit counts for %s", (input, expected) => {
    expect(exactDecimalDigitCounts(parsed(input))).toEqual(expected);
  });
});
