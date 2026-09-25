import {
  compareExactDecimals,
  formatExactDecimal,
  parseExactDecimal,
  type ExactDecimal,
  type FlowDateUnit,
  type FlowFormula,
  type FlowReference,
  type FlowRoundingMode,
  type JsonValue,
} from "@vortex/contracts";

/**
 * The one evaluator of the typed flow formula tree (architecture decision 1, "Formulas"): exact
 * decimal and money arithmetic with declared precision and rounding, comparison and boolean logic,
 * conditionals, text join, and date offset and difference. It is pure and total: it never reads a
 * clock, a record or a template. `now` and every reference come from the supplied scope, and any
 * value that does not have the type an operator needs is `undefined`, never coerced, so a caller
 * refuses the run instead of computing something the builder did not write.
 */

/** A runtime value carries its declared value type, so an operator never guesses from the shape. */
export type FlowRuntimeValue = Readonly<{ type: string; value: JsonValue }>;

/** What a formula may read. `undefined` from `reference` means the reference cannot be resolved. */
export type FlowFormulaScope = Readonly<{
  now: string;
  reference: (reference: FlowReference) => FlowRuntimeValue | undefined;
}>;

/**
 * Bounds on one computed value. A For each of set-variable tasks could otherwise square a number or
 * double a text on every item; a result beyond these bounds is `undefined`, so the run refuses.
 */
const maximumDecimalDigits = 100;
const maximumTextCharacters = 65_536;

const numericTypes = new Set(["whole_number", "decimal_number", "money"]);
const textTypes = new Set(["text", "formatted_text", "choice"]);

const value = (type: string, content: JsonValue): FlowRuntimeValue => ({ type, value: content });
const yesNo = (content: boolean) => value("yes_no", content);

const powerOfTen = (exponent: number): bigint => 10n ** BigInt(exponent);

const decimalOf = (candidate: FlowRuntimeValue): ExactDecimal | undefined => {
  if (candidate.type === "whole_number")
    return typeof candidate.value === "number" && Number.isSafeInteger(candidate.value)
      ? parseExactDecimal(String(candidate.value))
      : undefined;
  return numericTypes.has(candidate.type) ? parseExactDecimal(candidate.value) : undefined;
};

const absolute = (input: bigint): bigint => (input < 0n ? -input : input);

/** Divides exactly, then rounds the quotient to a whole number in the declared mode. */
const roundedQuotient = (numerator: bigint, denominator: bigint, mode: FlowRoundingMode): bigint => {
  if (denominator === 0n) throw new RangeError("division by zero");
  const negative = numerator < 0n !== denominator < 0n;
  const top = absolute(numerator);
  const bottom = absolute(denominator);
  const quotient = top / bottom;
  const remainder = top % bottom;
  if (remainder === 0n) return negative ? -quotient : quotient;
  const twice = remainder * 2n;
  let increment: boolean;
  switch (mode) {
    case "up":
      increment = true;
      break;
    case "down":
      increment = false;
      break;
    case "ceiling":
      increment = !negative;
      break;
    case "floor":
      increment = negative;
      break;
    case "half_up":
      increment = twice >= bottom;
      break;
    case "half_down":
      increment = twice > bottom;
      break;
    case "half_even":
      increment = twice > bottom || (twice === bottom && quotient % 2n === 1n);
      break;
  }
  const rounded = increment ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
};

/** Rescales `coefficient / 10^from` to exactly `to` decimal places. */
const rescale = (coefficient: bigint, from: number, to: number, mode: FlowRoundingMode) =>
  to >= from
    ? coefficient * powerOfTen(to - from)
    : roundedQuotient(coefficient, powerOfTen(from - to), mode);

const decimalText = (coefficient: bigint, scale: number): string => {
  const text = formatExactDecimal({ coefficient, scale } as ExactDecimal);
  return text;
};

const resultType = (operands: readonly FlowRuntimeValue[]): string =>
  operands.some((operand) => operand.type === "money") ? "money" : "decimal_number";

const arithmetic = (
  operator: "add" | "subtract" | "multiply" | "divide",
  operands: readonly FlowRuntimeValue[],
  scale: number,
  mode: FlowRoundingMode,
): FlowRuntimeValue | undefined => {
  const decimals = operands.map(decimalOf);
  if (decimals.some((decimal) => decimal === undefined)) return undefined;
  const parsed = decimals as ExactDecimal[];
  let coefficient = parsed[0]!.coefficient;
  let currentScale = parsed[0]!.scale;
  try {
    for (const next of parsed.slice(1)) {
      if (operator === "add" || operator === "subtract") {
        const common = Math.max(currentScale, next.scale);
        const left = coefficient * powerOfTen(common - currentScale);
        const right = next.coefficient * powerOfTen(common - next.scale);
        coefficient = operator === "add" ? left + right : left - right;
        currentScale = common;
      } else if (operator === "multiply") {
        coefficient *= next.coefficient;
        currentScale += next.scale;
      } else {
        // Divide straight to the declared scale so no precision beyond it is ever invented.
        const numerator = coefficient * powerOfTen(scale + next.scale);
        const denominator = next.coefficient * powerOfTen(currentScale);
        coefficient = roundedQuotient(numerator, denominator, mode);
        currentScale = scale;
      }
    }
    const scaled = rescale(coefficient, currentScale, scale, mode);
    if (absolute(scaled) >= powerOfTen(maximumDecimalDigits)) return undefined;
    return value(resultType(operands), decimalText(scaled, scale));
  } catch {
    return undefined;
  }
};

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

const instantOf = (candidate: FlowRuntimeValue): number | undefined => {
  if (typeof candidate.value !== "string") return undefined;
  if (candidate.type === "date_time" || candidate.type === "date") {
    const milliseconds = Date.parse(
      candidate.type === "date" && isoDatePattern.test(candidate.value)
        ? `${candidate.value}T00:00:00.000Z`
        : candidate.value,
    );
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  }
  return undefined;
};

const unitMilliseconds: Readonly<Partial<Record<FlowDateUnit, number>>> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
};

const addMonths = (milliseconds: number, months: number): number => {
  const start = new Date(milliseconds);
  const target = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return Date.UTC(
    target.getUTCFullYear(),
    target.getUTCMonth(),
    Math.min(start.getUTCDate(), lastDay),
    start.getUTCHours(),
    start.getUTCMinutes(),
    start.getUTCSeconds(),
    start.getUTCMilliseconds(),
  );
};

const dateAdd = (
  date: FlowRuntimeValue,
  amount: FlowRuntimeValue,
  unit: FlowDateUnit,
): FlowRuntimeValue | undefined => {
  const start = instantOf(date);
  if (start === undefined || amount.type !== "whole_number") return undefined;
  if (typeof amount.value !== "number" || !Number.isSafeInteger(amount.value)) return undefined;
  const fixed = unitMilliseconds[unit];
  const moved =
    fixed !== undefined
      ? start + amount.value * fixed
      : addMonths(start, unit === "years" ? amount.value * 12 : amount.value);
  if (!Number.isFinite(moved) || Number.isNaN(new Date(moved).getTime())) return undefined;
  const iso = new Date(moved).toISOString();
  if (date.type === "date") {
    // A calendar date moves only by whole calendar units.
    if (unit === "minutes" || unit === "hours") return undefined;
    return value("date", iso.slice(0, 10));
  }
  return value("date_time", iso);
};

const dateDiff = (
  from: FlowRuntimeValue,
  to: FlowRuntimeValue,
  unit: FlowDateUnit,
): FlowRuntimeValue | undefined => {
  const start = instantOf(from);
  const end = instantOf(to);
  if (start === undefined || end === undefined) return undefined;
  const fixed = unitMilliseconds[unit];
  if (fixed !== undefined) return value("whole_number", Math.trunc((end - start) / fixed));
  const first = new Date(start);
  const second = new Date(end);
  let months =
    (second.getUTCFullYear() - first.getUTCFullYear()) * 12 +
    (second.getUTCMonth() - first.getUTCMonth());
  // Whole months only: step back when the later date has not yet reached the earlier one's day.
  if (months > 0 && addMonths(start, months) > end) months -= 1;
  else if (months < 0 && addMonths(start, months) < end) months += 1;
  return value("whole_number", unit === "years" ? Math.trunc(months / 12) : months);
};

const isEmpty = (candidate: FlowRuntimeValue): boolean =>
  candidate.value === null ||
  candidate.value === "" ||
  (Array.isArray(candidate.value) && candidate.value.length === 0);

const deepEqual = (left: JsonValue, right: JsonValue): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const compare = (
  left: FlowRuntimeValue,
  right: FlowRuntimeValue,
): -1 | 0 | 1 | "equal_only_different" | "equal_only_same" | undefined => {
  const leftDecimal = decimalOf(left);
  const rightDecimal = decimalOf(right);
  if (leftDecimal !== undefined && rightDecimal !== undefined)
    return compareExactDecimals(leftDecimal, rightDecimal);
  if (numericTypes.has(left.type) || numericTypes.has(right.type)) return undefined;
  const leftInstant = instantOf(left);
  const rightInstant = instantOf(right);
  if (leftInstant !== undefined && rightInstant !== undefined)
    return leftInstant < rightInstant ? -1 : leftInstant > rightInstant ? 1 : 0;
  if (typeof left.value === "string" && typeof right.value === "string") {
    if (!textTypes.has(left.type) || !textTypes.has(right.type)) return undefined;
    return left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
  }
  if (left.type !== right.type) return undefined;
  return deepEqual(left.value, right.value) ? "equal_only_same" : "equal_only_different";
};

const joined = (candidate: FlowRuntimeValue): string | undefined => {
  if (typeof candidate.value === "string") return candidate.value;
  if (typeof candidate.value === "number") return String(candidate.value);
  if (typeof candidate.value === "boolean") return candidate.value ? "true" : "false";
  return undefined;
};

/** Evaluates a formula in a scope, or returns `undefined` when any operand is not of the right type. */
export const evaluateFlowFormula = (
  formula: FlowFormula,
  scope: FlowFormulaScope,
): FlowRuntimeValue | undefined => {
  const evaluate = (node: FlowFormula): FlowRuntimeValue | undefined => {
    switch (node.op) {
      case "literal":
        return value(node.type, node.value);
      case "reference":
        return scope.reference(node.reference as FlowReference);
      case "now":
        return value("date_time", scope.now);
      case "add":
      case "multiply":
      case "subtract":
      case "divide": {
        const operands = node.args.map(evaluate);
        return operands.some((operand) => operand === undefined)
          ? undefined
          : arithmetic(node.op, operands as FlowRuntimeValue[], node.scale, node.rounding);
      }
      case "round": {
        const operand = evaluate(node.arg);
        return operand === undefined
          ? undefined
          : arithmetic("add", [operand], node.scale, node.rounding);
      }
      case "eq":
      case "neq":
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        const left = evaluate(node.left);
        const right = evaluate(node.right);
        if (left === undefined || right === undefined) return undefined;
        const order = compare(left, right);
        if (order === undefined) return undefined;
        if (node.op === "eq" || node.op === "neq") {
          const equal = order === 0 || order === "equal_only_same";
          return yesNo(node.op === "eq" ? equal : !equal);
        }
        if (order === "equal_only_same" || order === "equal_only_different") return undefined;
        return yesNo(
          node.op === "lt"
            ? order < 0
            : node.op === "lte"
              ? order <= 0
              : node.op === "gt"
                ? order > 0
                : order >= 0,
        );
      }
      case "contains":
      case "starts_with":
      case "ends_with": {
        const left = evaluate(node.left);
        const right = evaluate(node.right);
        if (left === undefined || right === undefined) return undefined;
        if (typeof left.value === "string" && typeof right.value === "string") {
          if (!textTypes.has(left.type) || !textTypes.has(right.type)) return undefined;
          return yesNo(
            node.op === "contains"
              ? left.value.includes(right.value)
              : node.op === "starts_with"
                ? left.value.startsWith(right.value)
                : left.value.endsWith(right.value),
          );
        }
        if (node.op === "contains" && Array.isArray(left.value))
          return yesNo(left.value.some((item) => deepEqual(item, right.value)));
        return undefined;
      }
      case "is_empty":
      case "is_not_empty": {
        const operand = evaluate(node.arg);
        if (operand === undefined) return undefined;
        return yesNo(node.op === "is_empty" ? isEmpty(operand) : !isEmpty(operand));
      }
      case "in": {
        const target = evaluate(node.value);
        if (target === undefined) return undefined;
        let found = false;
        for (const option of node.options) {
          const candidate = evaluate(option);
          if (candidate === undefined) return undefined;
          const order = compare(target, candidate);
          if (order === undefined) return undefined;
          if (order === 0 || order === "equal_only_same") found = true;
        }
        return yesNo(found);
      }
      case "and":
      case "or": {
        const operands = node.args.map(evaluate);
        if (operands.some((operand) => operand?.type !== "yes_no")) return undefined;
        const truths = (operands as FlowRuntimeValue[]).map((operand) => operand.value === true);
        return yesNo(node.op === "and" ? truths.every(Boolean) : truths.some(Boolean));
      }
      case "not": {
        const operand = evaluate(node.arg);
        return operand?.type === "yes_no" ? yesNo(operand.value !== true) : undefined;
      }
      case "if": {
        const condition = evaluate(node.condition);
        if (condition?.type !== "yes_no") return undefined;
        return evaluate(condition.value === true ? node.then : node.else);
      }
      case "join": {
        const parts = node.parts.map(evaluate);
        const texts = parts.map((part) => (part === undefined ? undefined : joined(part)));
        if (texts.some((text) => text === undefined)) return undefined;
        const result = (texts as string[]).join(node.separator ?? "");
        return result.length > maximumTextCharacters ? undefined : value("text", result);
      }
      case "date_add": {
        const date = evaluate(node.date);
        const amount = evaluate(node.amount);
        return date === undefined || amount === undefined
          ? undefined
          : dateAdd(date, amount, node.unit);
      }
      case "date_diff": {
        const from = evaluate(node.from);
        const to = evaluate(node.to);
        return from === undefined || to === undefined ? undefined : dateDiff(from, to, node.unit);
      }
    }
  };
  return evaluate(formula);
};

/**
 * Whether two runtime values are equal in the sense of the `eq` operator, or `undefined` when the
 * two are not comparable (a switch then refuses instead of guessing).
 */
export const flowRuntimeValuesEqual = (
  left: FlowRuntimeValue,
  right: FlowRuntimeValue,
): boolean | undefined => {
  const order = compare(left, right);
  return order === undefined ? undefined : order === 0 || order === "equal_only_same";
};
