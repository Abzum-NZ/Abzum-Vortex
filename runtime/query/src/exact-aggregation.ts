import "server-only";

import {
  compareExactDecimals,
  formatExactDecimal,
  parseExactDecimal,
  type ExactDecimal,
  type JsonValue,
  type ModuleQueryAggregate,
} from "@vortex/contracts";
import type { ProtectedQueryRow } from "./protected-query-contracts";
import type {
  AggregateComputationResult,
  AggregateDescriptor,
} from "./arrangement-contracts";

const powerOfTen = (exponent: number): bigint =>
  exponent <= 0 ? 1n : 10n ** BigInt(exponent);

/**
 * Formats a BigInt coefficient and scale into standard base-10 decimal text.
 * Never converts through JavaScript floating point numbers.
 */
export const formatBigIntDecimal = (coefficient: bigint, scale: number): string => {
  if (coefficient === 0n) return "0";

  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString();
  let magnitude: string;

  if (scale === 0) {
    magnitude = digits;
  } else if (digits.length <= scale) {
    magnitude = `0.${"0".repeat(scale - digits.length)}${digits}`;
  } else {
    const decimalIndex = digits.length - scale;
    magnitude = `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  }

  return negative ? `-${magnitude}` : magnitude;
};

/**
 * Adds two ExactDecimal values without floating-point conversion.
 */
export const addExactDecimals = (left: ExactDecimal, right: ExactDecimal): ExactDecimal => {
  const commonScale = Math.max(left.scale, right.scale);
  const leftCoeff = left.coefficient * powerOfTen(commonScale - left.scale);
  const rightCoeff = right.coefficient * powerOfTen(commonScale - right.scale);
  const sumCoeff = leftCoeff + rightCoeff;
  const formatted = formatBigIntDecimal(sumCoeff, commonScale);
  const parsed = parseExactDecimal(formatted);
  if (parsed === undefined) throw new Error("EXACT_DECIMAL_ADDITION_ERROR");
  return parsed;
};

/**
 * Sums an array of ExactDecimal values exactly using BigInt.
 */
export const sumExactDecimals = (values: readonly ExactDecimal[]): ExactDecimal => {
  if (values.length === 0) {
    return parseExactDecimal("0")!;
  }
  let maxScale = 0;
  for (const v of values) {
    if (v.scale > maxScale) maxScale = v.scale;
  }
  let totalCoeff = 0n;
  for (const v of values) {
    totalCoeff += v.coefficient * powerOfTen(maxScale - v.scale);
  }
  const formatted = formatBigIntDecimal(totalCoeff, maxScale);
  const parsed = parseExactDecimal(formatted);
  if (parsed === undefined) throw new Error("EXACT_DECIMAL_SUM_ERROR");
  return parsed;
};

/**
 * Divides an ExactDecimal by a positive integer divisor with exact half-up rounding.
 * Never uses floating-point arithmetic.
 */
export const divideExactDecimal = (
  value: ExactDecimal,
  divisor: number,
  decimalPlaces = 2,
): ExactDecimal => {
  if (divisor <= 0) throw new Error("EXACT_DECIMAL_DIVISION_BY_ZERO");
  if (value.coefficient === 0n) return parseExactDecimal("0")!;

  const places = Math.max(0, Math.min(12, decimalPlaces));
  const bigDivisor = BigInt(divisor);

  // Exact division: value / divisor = (value.coefficient / 10^value.scale) / bigDivisor
  // Result to `places` decimal places:
  // num = |value.coefficient| * 10^places
  // den = bigDivisor * 10^value.scale
  const absCoeff = value.coefficient < 0n ? -value.coefficient : value.coefficient;
  const num = absCoeff * powerOfTen(places);
  const den = bigDivisor * powerOfTen(value.scale);

  let quotient = num / den;
  const remainder = num % den;
  // Half-up rounding: if 2 * remainder >= den, round up
  if (2n * remainder >= den) {
    quotient += 1n;
  }

  const finalCoeff = value.coefficient < 0n ? -quotient : quotient;
  const formatted = formatBigIntDecimal(finalCoeff, places);
  const parsed = parseExactDecimal(formatted);
  if (parsed === undefined) throw new Error("EXACT_DECIMAL_DIVISION_ERROR");
  return parsed;
};

const isMoneyObject = (v: unknown): v is { amount: string; currency: string } =>
  typeof v === "object" &&
  v !== null &&
  "amount" in v &&
  typeof (v as { amount: unknown }).amount === "string" &&
  "currency" in v &&
  typeof (v as { currency: unknown }).currency === "string";

const isIsoDateOrDateTime = (s: string): boolean =>
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2}))?$/.test(s);

/**
 * Pure function to compute a single field aggregate across authorized rows.
 * Exact decimal and money aggregation never convert through JavaScript number.
 * A money aggregate returns a typed refusal if filtered/grouped values contain more than one currency.
 */
export const computeFieldAggregate = (
  rows: readonly ProtectedQueryRow[],
  aggregate: ModuleQueryAggregate | AggregateDescriptor,
): AggregateComputationResult => {
  // 1. Count operation
  if (aggregate.operation === "count") {
    if (aggregate.fieldId === undefined) {
      return { outcome: "completed", value: rows.length };
    }
    const nonNullCount = rows.filter((r) => {
      const v = r.values[aggregate.fieldId!];
      return v !== undefined && v !== null;
    }).length;
    return { outcome: "completed", value: nonNullCount };
  }

  // 2. Non-count operations require fieldId
  if (!aggregate.fieldId) {
    return {
      outcome: "refused",
      reasonCode: "descriptor_invalid",
      message: "Field ID is required for non-count aggregate",
    };
  }

  const rawValues = rows
    .map((r) => r.values[aggregate.fieldId!])
    .filter((v): v is NonNullable<JsonValue> => v !== undefined && v !== null);

  if (rawValues.length === 0) {
    return { outcome: "completed", value: null };
  }

  // 3. Money values handling
  const moneyItems = rawValues.filter(isMoneyObject);
  if (moneyItems.length > 0) {
    if (moneyItems.length !== rawValues.length) {
      return {
        outcome: "refused",
        reasonCode: "incompatible_type",
        message: "Mixed money and non-money values in field",
      };
    }

    const currencies = Array.from(
      new Set(moneyItems.map((m) => m.currency.toUpperCase())),
    ).sort();
    if (currencies.length > 1) {
      return {
        outcome: "refused",
        reasonCode: "mixed_currency",
        currencies,
        message: "Money aggregate refused: multiple currencies present in group",
      };
    }

    const currency = currencies[0]!;
    const parsedAmounts: ExactDecimal[] = [];
    for (const item of moneyItems) {
      const parsed = parseExactDecimal(item.amount);
      if (parsed === undefined) {
        return {
          outcome: "refused",
          reasonCode: "incompatible_type",
          message: `Invalid exact money amount: ${item.amount}`,
        };
      }
      parsedAmounts.push(parsed);
    }

    if (aggregate.operation === "sum") {
      const sum = sumExactDecimals(parsedAmounts);
      return {
        outcome: "completed",
        value: { amount: formatExactDecimal(sum), currency },
      };
    }

    if (aggregate.operation === "average") {
      const sum = sumExactDecimals(parsedAmounts);
      const avg = divideExactDecimal(
        sum,
        parsedAmounts.length,
        ("decimalPlaces" in aggregate ? aggregate.decimalPlaces : undefined) ?? 2,
      );
      return {
        outcome: "completed",
        value: { amount: formatExactDecimal(avg), currency },
      };
    }

    if (aggregate.operation === "minimum") {
      let min = parsedAmounts[0]!;
      for (const cur of parsedAmounts) {
        if (compareExactDecimals(cur, min) < 0) min = cur;
      }
      return {
        outcome: "completed",
        value: { amount: formatExactDecimal(min), currency },
      };
    }

    if (aggregate.operation === "maximum") {
      let max = parsedAmounts[0]!;
      for (const cur of parsedAmounts) {
        if (compareExactDecimals(cur, max) > 0) max = cur;
      }
      return {
        outcome: "completed",
        value: { amount: formatExactDecimal(max), currency },
      };
    }
  }

  // 4. Whole numbers only (all integers)
  const isAllIntegers = rawValues.every(
    (v) => typeof v === "number" && Number.isInteger(v),
  );
  if (isAllIntegers) {
    const nums = rawValues as number[];
    if (aggregate.operation === "sum") {
      let sumBig = 0n;
      for (const n of nums) sumBig += BigInt(n);
      const val =
        sumBig >= BigInt(Number.MIN_SAFE_INTEGER) &&
        sumBig <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(sumBig)
          : sumBig.toString();
      return { outcome: "completed", value: val };
    }

    if (aggregate.operation === "average") {
      let sumBig = 0n;
      for (const n of nums) sumBig += BigInt(n);
      const sumDec = parseExactDecimal(sumBig.toString())!;
      const avg = divideExactDecimal(
        sumDec,
        nums.length,
        ("decimalPlaces" in aggregate ? aggregate.decimalPlaces : undefined) ?? 2,
      );
      return { outcome: "completed", value: formatExactDecimal(avg) };
    }

    if (aggregate.operation === "minimum") {
      let min = nums[0]!;
      for (const n of nums) {
        if (n < min) min = n;
      }
      return { outcome: "completed", value: min };
    }

    if (aggregate.operation === "maximum") {
      let max = nums[0]!;
      for (const n of nums) {
        if (n > max) max = n;
      }
      return { outcome: "completed", value: max };
    }
  }

  // 5. Exact decimals (exact decimal strings, or integers)
  const parsedDecimals: ExactDecimal[] = [];
  let allDecimals = true;
  for (const v of rawValues) {
    if (typeof v === "string") {
      const parsed = parseExactDecimal(v);
      if (parsed !== undefined) {
        parsedDecimals.push(parsed);
      } else {
        allDecimals = false;
        break;
      }
    } else if (typeof v === "number" && Number.isInteger(v)) {
      const parsed = parseExactDecimal(v.toString());
      if (parsed !== undefined) {
        parsedDecimals.push(parsed);
      } else {
        allDecimals = false;
        break;
      }
    } else {
      // Reject non-integer floating point numbers or unsupported types
      allDecimals = false;
      break;
    }
  }

  if (allDecimals && parsedDecimals.length === rawValues.length) {
    if (aggregate.operation === "sum") {
      const sum = sumExactDecimals(parsedDecimals);
      return { outcome: "completed", value: formatExactDecimal(sum) };
    }

    if (aggregate.operation === "average") {
      const maxScale = Math.max(...parsedDecimals.map((d) => d.scale), 0);
      const sum = sumExactDecimals(parsedDecimals);
      const avg = divideExactDecimal(
        sum,
        parsedDecimals.length,
        ("decimalPlaces" in aggregate ? aggregate.decimalPlaces : undefined) ??
          Math.max(2, maxScale),
      );
      return { outcome: "completed", value: formatExactDecimal(avg) };
    }

    if (aggregate.operation === "minimum") {
      let min = parsedDecimals[0]!;
      for (const d of parsedDecimals) {
        if (compareExactDecimals(d, min) < 0) min = d;
      }
      return { outcome: "completed", value: formatExactDecimal(min) };
    }

    if (aggregate.operation === "maximum") {
      let max = parsedDecimals[0]!;
      for (const d of parsedDecimals) {
        if (compareExactDecimals(d, max) > 0) max = d;
      }
      return { outcome: "completed", value: formatExactDecimal(max) };
    }
  }

  // 6. Dates and date-times (ISO strings)
  const isAllDates = rawValues.every(
    (v) => typeof v === "string" && isIsoDateOrDateTime(v),
  );
  if (isAllDates) {
    const strs = rawValues as string[];
    if (aggregate.operation === "minimum") {
      let minStr = strs[0]!;
      let minTime = new Date(minStr).getTime();
      for (const s of strs) {
        const t = new Date(s).getTime();
        if (t < minTime) {
          minTime = t;
          minStr = s;
        }
      }
      return { outcome: "completed", value: minStr };
    }

    if (aggregate.operation === "maximum") {
      let maxStr = strs[0]!;
      let maxTime = new Date(maxStr).getTime();
      for (const s of strs) {
        const t = new Date(s).getTime();
        if (t > maxTime) {
          maxTime = t;
          maxStr = s;
        }
      }
      return { outcome: "completed", value: maxStr };
    }

    if (aggregate.operation === "sum" || aggregate.operation === "average") {
      return {
        outcome: "refused",
        reasonCode: "incompatible_type",
        message: `Operation '${aggregate.operation}' is not supported on date/time fields`,
      };
    }
  }

  // 7. General strings (for min/max only)
  const isAllStrings = rawValues.every((v) => typeof v === "string");
  if (isAllStrings) {
    const strs = rawValues as string[];
    if (aggregate.operation === "minimum") {
      let min = strs[0]!;
      for (const s of strs) {
        if (s.localeCompare(min) < 0) min = s;
      }
      return { outcome: "completed", value: min };
    }

    if (aggregate.operation === "maximum") {
      let max = strs[0]!;
      for (const s of strs) {
        if (s.localeCompare(max) > 0) max = s;
      }
      return { outcome: "completed", value: max };
    }

    if (aggregate.operation === "sum" || aggregate.operation === "average") {
      return {
        outcome: "refused",
        reasonCode: "incompatible_type",
        message: `Operation '${aggregate.operation}' requires numeric, decimal or money field`,
      };
    }
  }

  return {
    outcome: "refused",
    reasonCode: "incompatible_type",
    message: `Unsupported value types for operation '${aggregate.operation}'`,
  };
};

/**
 * Computes all declared aggregates across a row set.
 */
export const computeAggregates = (
  rows: readonly ProtectedQueryRow[],
  aggregates: readonly (ModuleQueryAggregate | AggregateDescriptor)[],
): Record<string, AggregateComputationResult> => {
  const result: Record<string, AggregateComputationResult> = {};
  for (const agg of aggregates) {
    result[agg.alias] = computeFieldAggregate(rows, agg);
  }
  return Object.freeze(result);
};
