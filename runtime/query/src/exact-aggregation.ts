import "server-only";

import {
  compareExactDecimals,
  formatExactDecimal,
  parseExactDecimal,
  type ExactDecimal,
  type JsonValue,
} from "@vortex/contracts";
import type {
  AggregateDescriptor,
  AggregateResult,
  ArrangementField,
  ArrangementRow,
} from "./arrangement-contracts";

type FieldType = ArrangementField["type"];
type Operation = AggregateDescriptor["operation"];
type Money = Readonly<{ amount: string; currency: string }>;

const summableTypes: ReadonlySet<FieldType> = new Set(["whole_number", "decimal_number", "money"]);
const orderedTypes: ReadonlySet<FieldType> = new Set([
  "whole_number",
  "decimal_number",
  "money",
  "date",
  "date_time",
]);

/** Whether a field of this declared type permits the aggregate operation. */
export const aggregateSupportsFieldType = (operation: Operation, type: FieldType): boolean => {
  if (operation === "count") return true;
  if (operation === "minimum" || operation === "maximum") return orderedTypes.has(type);
  return summableTypes.has(type);
};

const powerOfTen = (exponent: number): bigint => 10n ** BigInt(exponent);

/** Canonical exact text for coefficient × 10^-scale, without a JavaScript number. */
const scaledText = (coefficient: bigint, scale: number): string => {
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, "0");
  const magnitude = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  const parsed = parseExactDecimal(negative ? `-${magnitude}` : magnitude);
  if (parsed === undefined) throw new Error("EXACT_DECIMAL_INVALID");
  return formatExactDecimal(parsed);
};

const exactSum = (values: readonly ExactDecimal[]): Readonly<{ coefficient: bigint; scale: number }> => {
  let scale = 0;
  for (const value of values) if (value.scale > scale) scale = value.scale;
  let coefficient = 0n;
  for (const value of values) coefficient += value.coefficient * powerOfTen(scale - value.scale);
  return { coefficient, scale };
};

/** Exact mean rounded half away from zero to `decimalPlaces`. */
const exactAverage = (values: readonly ExactDecimal[], decimalPlaces: number): string => {
  const sum = exactSum(values);
  const magnitude = sum.coefficient < 0n ? -sum.coefficient : sum.coefficient;
  const numerator = magnitude * powerOfTen(decimalPlaces);
  const denominator = BigInt(values.length) * powerOfTen(sum.scale);
  let quotient = numerator / denominator;
  if (2n * (numerator % denominator) >= denominator) quotient += 1n;
  return scaledText(sum.coefficient < 0n ? -quotient : quotient, decimalPlaces);
};

const exactExtreme = (values: readonly ExactDecimal[], operation: "minimum" | "maximum"): number => {
  let chosen = 0;
  for (let index = 1; index < values.length; index += 1) {
    const order = compareExactDecimals(values[index]!, values[chosen]!);
    if (operation === "minimum" ? order < 0 : order > 0) chosen = index;
  }
  return chosen;
};

const exact = (text: string): ExactDecimal => {
  const parsed = parseExactDecimal(text);
  if (parsed === undefined) throw new Error("EXACT_DECIMAL_INVALID");
  return parsed;
};

const codeUnitOrder = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** Date-times order by instant; equal instants order by their text so the result is stable. */
const dateTimeOrder = (left: string, right: string): number => {
  const difference = Date.parse(left) - Date.parse(right);
  return difference < 0 ? -1 : difference > 0 ? 1 : codeUnitOrder(left, right);
};

const numericResult = (
  values: readonly ExactDecimal[],
  aggregate: AggregateDescriptor,
): string => {
  if (aggregate.operation === "sum") {
    const sum = exactSum(values);
    return scaledText(sum.coefficient, sum.scale);
  }
  return exactAverage(values, aggregate.decimalPlaces ?? 2);
};

/**
 * Computes one aggregate over rows whose values were already checked against
 * the field's declared type. Missing, empty and withheld values are skipped and
 * reported through `valueCount`. Decimal and money arithmetic is exact BigInt
 * arithmetic on canonical text; nothing passes through a JavaScript number.
 */
const computeAggregate = (
  rows: readonly ArrangementRow[],
  aggregate: AggregateDescriptor,
  fieldType: FieldType | undefined,
): AggregateResult => {
  if (aggregate.fieldId === undefined)
    return { outcome: "completed", value: rows.length, valueCount: rows.length };
  if (fieldType === undefined) throw new Error("AGGREGATE_FIELD_UNDECLARED");
  const fieldId = aggregate.fieldId.toLowerCase();
  const present: JsonValue[] = [];
  for (const row of rows) {
    const value = (row.values as Readonly<Record<string, JsonValue>>)[fieldId];
    if (value !== undefined && value !== null) present.push(value);
  }
  const valueCount = present.length;
  if (aggregate.operation === "count") return { outcome: "completed", value: valueCount, valueCount };
  if (valueCount === 0) return { outcome: "completed", value: null, valueCount };

  switch (fieldType) {
    case "money": {
      const money = present as unknown as readonly Money[];
      const currency = money[0]!.currency;
      if (money.some((value) => value.currency !== currency))
        return { outcome: "refused", reasonCode: "mixed_currency" };
      const amounts = money.map((value) => exact(value.amount));
      if (aggregate.operation === "minimum" || aggregate.operation === "maximum")
        return { outcome: "completed", value: money[exactExtreme(amounts, aggregate.operation)]!, valueCount };
      return {
        outcome: "completed",
        value: { amount: numericResult(amounts, aggregate), currency },
        valueCount,
      };
    }
    case "whole_number": {
      const numbers = present as readonly number[];
      // Safe integers print as plain base-10 text, so this is exact.
      const values = numbers.map((value) => exact(String(value)));
      if (aggregate.operation === "minimum" || aggregate.operation === "maximum")
        return { outcome: "completed", value: numbers[exactExtreme(values, aggregate.operation)]!, valueCount };
      return { outcome: "completed", value: numericResult(values, aggregate), valueCount };
    }
    case "decimal_number": {
      const texts = present as readonly string[];
      const values = texts.map(exact);
      if (aggregate.operation === "minimum" || aggregate.operation === "maximum")
        return { outcome: "completed", value: texts[exactExtreme(values, aggregate.operation)]!, valueCount };
      return { outcome: "completed", value: numericResult(values, aggregate), valueCount };
    }
    case "date":
    case "date_time": {
      const order = fieldType === "date" ? codeUnitOrder : dateTimeOrder;
      const texts = present as readonly string[];
      let chosen = texts[0]!;
      for (const text of texts) {
        const comparison = order(text, chosen);
        if (aggregate.operation === "minimum" ? comparison < 0 : comparison > 0) chosen = text;
      }
      return { outcome: "completed", value: chosen, valueCount };
    }
    default:
      throw new Error("AGGREGATE_FIELD_TYPE_UNSUPPORTED");
  }
};

/** Computes every declared aggregate, keyed by alias, over one row set. */
export const computeAggregates = (
  rows: readonly ArrangementRow[],
  aggregates: readonly AggregateDescriptor[],
  fieldTypes: ReadonlyMap<string, FieldType>,
): Record<string, AggregateResult> => {
  const results: Record<string, AggregateResult> = {};
  for (const aggregate of aggregates) {
    const fieldType =
      aggregate.fieldId === undefined ? undefined : fieldTypes.get(aggregate.fieldId.toLowerCase());
    results[aggregate.alias] = computeAggregate(rows, aggregate, fieldType);
  }
  return results;
};
