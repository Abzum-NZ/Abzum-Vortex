import { valueTypesCompatible } from "../catalogue/catalogues";
import type { JsonValue } from "../catalogue/common";
import {
  compareExactDecimals,
  formatExactDecimal,
  parseExactDecimal,
  powerOfTen,
  type ExactDecimal,
} from "../records/exact-decimal";
import { moneyValueSchema, recordLinkValueSchema } from "../records/module-field-values";
import type {
  FlowDateUnit,
  FlowFormula,
  FlowReference,
  FlowRoundingMode,
} from "../workflows/flow-values";
import { flowInstantMicros } from "./flow-instant";

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
  organizationLocalDate?: string | undefined;
  reference: (reference: FlowReference) => FlowRuntimeValue | undefined;
}>;

/**
 * Bounds on one computed value. A For each of set-variable tasks could otherwise square a number or
 * double a text on every item; a result beyond these bounds is `undefined`, so the run refuses.
 */
const maximumDecimalDigits = 100;
const maximumTextCharacters = 65_536;

const isNumericType = (type: string): boolean =>
  ["whole_number", "decimal_number", "money"].includes(type);
const isTextType = (type: string): boolean => ["text", "choice", "formatted_text"].includes(type);

const value = (type: string, content: JsonValue): FlowRuntimeValue => ({ type, value: content });
const yesNo = (content: boolean) => value("yes_no", content);

const decimalOf = (candidate: FlowRuntimeValue): ExactDecimal | undefined => {
  if (candidate.type === "whole_number")
    return typeof candidate.value === "number" && Number.isSafeInteger(candidate.value)
      ? parseExactDecimal(String(candidate.value))
      : undefined;
  if (candidate.type === "money") {
    // Flow literals carry an amount; stored Record values also carry a currency.
    if (typeof candidate.value === "string") return parseExactDecimal(candidate.value);
    const money = moneyValueSchema.safeParse(candidate.value);
    return money.success ? parseExactDecimal(money.data.amount) : undefined;
  }
  return isNumericType(candidate.type) ? parseExactDecimal(candidate.value) : undefined;
};

const absolute = (input: bigint): bigint => (input < 0n ? -input : input);

type ExactRational = Readonly<{ numerator: bigint; denominator: bigint }>;

const greatestCommonDivisor = (left: bigint, right: bigint): bigint => {
  let a = absolute(left);
  let b = absolute(right);
  while (b !== 0n) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
};

const rational = (numerator: bigint, denominator: bigint): ExactRational | undefined => {
  if (denominator === 0n) return undefined;
  const divisor = greatestCommonDivisor(numerator, denominator);
  const sign = denominator < 0n ? -1n : 1n;
  return {
    numerator: (numerator * sign) / divisor,
    denominator: absolute(denominator) / divisor,
  };
};

const rationalOf = (decimal: ExactDecimal): ExactRational =>
  rational(decimal.coefficient, powerOfTen(decimal.scale))!;

const combineRationals = (
  operator: "add" | "subtract" | "multiply" | "divide",
  left: ExactRational,
  right: ExactRational,
): ExactRational | undefined => {
  switch (operator) {
    case "add":
      return rational(
        left.numerator * right.denominator + right.numerator * left.denominator,
        left.denominator * right.denominator,
      );
    case "subtract":
      return rational(
        left.numerator * right.denominator - right.numerator * left.denominator,
        left.denominator * right.denominator,
      );
    case "multiply":
      return rational(left.numerator * right.numerator, left.denominator * right.denominator);
    case "divide":
      return rational(left.numerator * right.denominator, left.denominator * right.numerator);
  }
};

/** Divides exactly, then rounds the quotient to a whole number in the declared mode. */
const roundedQuotient = (
  numerator: bigint,
  denominator: bigint,
  mode: FlowRoundingMode,
): bigint => {
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

const currencyOf = (candidate: FlowRuntimeValue): string | undefined => {
  if (candidate.type !== "money") return undefined;
  const parsed = moneyValueSchema.safeParse(candidate.value);
  return parsed.success ? parsed.data.currency : undefined;
};

const codePointCompare = (left: string, right: string): number => {
  const leftPoints = [...left].map((entry) => entry.codePointAt(0)!);
  const rightPoints = [...right].map((entry) => entry.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
};

export const compareFlowText = codePointCompare;

const arithmetic = (
  operator: "add" | "subtract" | "multiply" | "divide",
  operands: readonly FlowRuntimeValue[],
  scale: number,
  mode: FlowRoundingMode,
  exactValues: WeakMap<FlowRuntimeValue, ExactRational>,
  preserveExactArithmetic: boolean,
): FlowRuntimeValue | undefined => {
  const parsed = operands.map((operand) => {
    const carried = exactValues.get(operand);
    if (carried !== undefined) return carried;
    const decimal = decimalOf(operand);
    return decimal === undefined ? undefined : rationalOf(decimal);
  });
  if (parsed.some((entry) => entry === undefined)) return undefined;
  const moneyOperands = operands.filter((operand) => operand.type === "money");
  const textMoneyOperands = moneyOperands.filter((operand) => typeof operand.value === "string");
  if (textMoneyOperands.length > 0 && textMoneyOperands.length !== moneyOperands.length)
    return undefined;
  const currencies = moneyOperands.map(currencyOf);
  const commonCurrency =
    currencies.length > 0 &&
    currencies.every((currency) => currency !== undefined && currency === currencies[0])
      ? currencies[0]
      : undefined;
  const dimensionsValid =
    operator === "add" || operator === "subtract"
      ? moneyOperands.length === 0 ||
        (moneyOperands.length === operands.length &&
          (textMoneyOperands.length === moneyOperands.length || commonCurrency !== undefined))
      : operator === "multiply"
        ? moneyOperands.length <= 1
        : moneyOperands.length === 0 ||
          (moneyOperands.length === 1 &&
            operands[0]?.type === "money" &&
            (textMoneyOperands.length === 1 || commonCurrency !== undefined));
  if (!dimensionsValid) return undefined;
  let exact = parsed[0]!;
  try {
    for (const next of parsed.slice(1)) {
      const combined = combineRationals(operator, exact, next!);
      if (
        combined === undefined ||
        absolute(combined.numerator).toString().length > 512 ||
        combined.denominator.toString().length > 512
      )
        return undefined;
      exact = combined;
    }
    const scaled = roundedQuotient(exact.numerator * powerOfTen(scale), exact.denominator, mode);
    if (absolute(scaled) >= powerOfTen(maximumDecimalDigits)) return undefined;
    const amount = formatExactDecimal(
      parseExactDecimal(formatExactDecimal({ coefficient: scaled, scale } as ExactDecimal))!,
    );
    if (commonCurrency !== undefined) {
      const result = value("money", { amount, currency: commonCurrency });
      if (preserveExactArithmetic) exactValues.set(result, exact);
      return result;
    }
    if (textMoneyOperands.length > 0) {
      const result = value("money", amount);
      if (preserveExactArithmetic) exactValues.set(result, exact);
      return result;
    }
    if (
      operator !== "divide" &&
      scale === 0 &&
      operands.every((operand) => operand.type === "whole_number")
    ) {
      const whole = Number(amount);
      if (!Number.isSafeInteger(whole)) {
        if (!preserveExactArithmetic) return undefined;
        const result = value("decimal_number", amount);
        exactValues.set(result, exact);
        return result;
      }
      const result = value("whole_number", whole);
      if (preserveExactArithmetic) exactValues.set(result, exact);
      return result;
    }
    const result = value("decimal_number", amount);
    if (preserveExactArithmetic) exactValues.set(result, exact);
    return result;
    // guard-allow: silent-catch Arithmetic outside the exact decimal range has no formula value.
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

type ExactInstant = Readonly<{ epochSecond: bigint; fraction: string }>;

const exactInstantOf = (candidate: FlowRuntimeValue): ExactInstant | undefined => {
  if (typeof candidate.value !== "string") return undefined;
  if (candidate.type === "date") {
    const milliseconds = instantOf(candidate);
    return milliseconds === undefined
      ? undefined
      : { epochSecond: BigInt(Math.floor(milliseconds / 1_000)), fraction: "" };
  }
  if (candidate.type !== "date_time") return undefined;
  const microseconds = flowInstantMicros(candidate.value);
  if (microseconds === undefined) return undefined;
  const epochSecond =
    microseconds < 0n && microseconds % 1_000_000n !== 0n
      ? microseconds / 1_000_000n - 1n
      : microseconds / 1_000_000n;
  const fractionalMicros = microseconds - epochSecond * 1_000_000n;
  const fraction =
    fractionalMicros === 0n ? "" : fractionalMicros.toString().padStart(6, "0").replace(/0+$/, "");
  return { epochSecond, fraction };
};

const compareInstants = (left: ExactInstant, right: ExactInstant): -1 | 0 | 1 => {
  if (left.epochSecond < right.epochSecond) return -1;
  if (left.epochSecond > right.epochSecond) return 1;
  const scale = Math.max(left.fraction.length, right.fraction.length);
  const leftFraction = left.fraction.padEnd(scale, "0");
  const rightFraction = right.fraction.padEnd(scale, "0");
  return leftFraction < rightFraction ? -1 : leftFraction > rightFraction ? 1 : 0;
};

const unitMilliseconds: Readonly<Partial<Record<FlowDateUnit, number>>> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
};

const addMonths = (milliseconds: number, months: number): number => {
  const start = new Date(milliseconds);
  const target = new Date(0);
  target.setUTCHours(0, 0, 0, 0);
  target.setUTCFullYear(start.getUTCFullYear(), start.getUTCMonth() + months, 1);
  const endOfMonth = new Date(0);
  endOfMonth.setUTCHours(0, 0, 0, 0);
  endOfMonth.setUTCFullYear(target.getUTCFullYear(), target.getUTCMonth() + 1, 0);
  target.setUTCDate(Math.min(start.getUTCDate(), endOfMonth.getUTCDate()));
  target.setUTCHours(
    start.getUTCHours(),
    start.getUTCMinutes(),
    start.getUTCSeconds(),
    start.getUTCMilliseconds(),
  );
  return target.getTime();
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
  const fraction = /\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/.exec(String(date.value))?.[1] ?? "";
  return value(
    "date_time",
    iso.replace(/\.\d{3}Z$/, (fraction === "" ? "" : "." + fraction) + "Z"),
  );
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
  const exactStart = exactInstantOf(from);
  const exactEnd = exactInstantOf(to);
  if (exactStart === undefined || exactEnd === undefined) return undefined;
  if (fixed !== undefined) {
    const scale = Math.max(exactStart.fraction.length, exactEnd.fraction.length);
    const startFraction = BigInt(exactStart.fraction.padEnd(scale, "0") || "0");
    const endFraction = BigInt(exactEnd.fraction.padEnd(scale, "0") || "0");
    const difference =
      (exactEnd.epochSecond - exactStart.epochSecond) * powerOfTen(scale) +
      endFraction -
      startFraction;
    const whole = Number(difference / (BigInt(fixed / 1_000) * powerOfTen(scale)));
    return Number.isSafeInteger(whole) ? value("whole_number", whole) : undefined;
  }
  const first = new Date(start);
  const second = new Date(end);
  let months =
    (second.getUTCFullYear() - first.getUTCFullYear()) * 12 +
    (second.getUTCMonth() - first.getUTCMonth());
  // Whole months only: step back when the later date has not yet reached the earlier one's day.
  const shifted = (amount: number): ExactInstant => ({
    epochSecond: BigInt(Math.floor(addMonths(start, amount) / 1_000)),
    fraction: exactStart.fraction,
  });
  if (months > 0 && compareInstants(shifted(months), exactEnd) > 0) months -= 1;
  else if (months < 0 && compareInstants(shifted(months), exactEnd) < 0) months += 1;
  return value("whole_number", unit === "years" ? Math.trunc(months / 12) : months);
};

const isEmpty = (candidate: FlowRuntimeValue): boolean =>
  candidate.value === null ||
  candidate.value === "" ||
  (Array.isArray(candidate.value) && candidate.value.length === 0);

export const flowJsonValuesEqual = (left: JsonValue, right: JsonValue): boolean => {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object")
    return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => flowJsonValuesEqual(entry, right[index]!))
    );
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && flowJsonValuesEqual(left[key]!, right[key]!),
    )
  );
};

const compare = (
  left: FlowRuntimeValue,
  right: FlowRuntimeValue,
): -1 | 0 | 1 | "equal_only_different" | "equal_only_same" | undefined => {
  if (left.value === null || right.value === null)
    return left.value === right.value ? "equal_only_same" : "equal_only_different";
  const leftDecimal = decimalOf(left);
  const rightDecimal = decimalOf(right);
  if (leftDecimal !== undefined && rightDecimal !== undefined) {
    if ((left.type === "money") !== (right.type === "money")) return undefined;
    if (left.type === "money" && right.type === "money") {
      const leftCurrency = currencyOf(left);
      const rightCurrency = currencyOf(right);
      if (leftCurrency === undefined || rightCurrency === undefined) {
        if (typeof left.value !== "string" || typeof right.value !== "string") return undefined;
      }
      if (leftCurrency !== rightCurrency) return "equal_only_different";
    }
    return compareExactDecimals(leftDecimal, rightDecimal);
  }
  if (isNumericType(left.type) || isNumericType(right.type)) return undefined;
  const leftInstant = exactInstantOf(left);
  const rightInstant = exactInstantOf(right);
  if (leftInstant !== undefined && rightInstant !== undefined)
    return compareInstants(leftInstant, rightInstant);
  if (typeof left.value === "string" && typeof right.value === "string") {
    if (!isTextType(left.type) || !isTextType(right.type)) return undefined;
    const order = compareFlowText(left.value, right.value);
    return order < 0 ? -1 : order > 0 ? 1 : 0;
  }
  if (left.type !== right.type) return undefined;
  if (left.type === "yes_no" && typeof left.value === "boolean" && typeof right.value === "boolean")
    return left.value === right.value ? "equal_only_same" : "equal_only_different";
  return flowJsonValuesEqual(left.value, right.value) ? "equal_only_same" : "equal_only_different";
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
  options: Readonly<{
    preserveExactArithmetic?: boolean;
    requireExactInteger?: boolean;
    /** Rounds a decimal or money result once, from its exact value, to this many places. */
    resultScale?: number;
  }> = {},
): FlowRuntimeValue | undefined => {
  const exactValues = new WeakMap<FlowRuntimeValue, ExactRational>();
  const evaluate = (node: FlowFormula): FlowRuntimeValue | undefined => {
    switch (node.op) {
      case "literal":
        return value(node.type, node.value);
      case "reference":
        return scope.reference(node.reference as FlowReference);
      case "now":
        return value("date_time", scope.now);
      case "record_id": {
        const operand = evaluate(node.arg);
        if (
          operand?.type !== "json" ||
          operand.value === null ||
          typeof operand.value !== "object" ||
          Array.isArray(operand.value) ||
          Reflect.ownKeys(operand.value).length !== 2 ||
          !Object.hasOwn(operand.value, "recordTypeId") ||
          !Object.hasOwn(operand.value, "recordId")
        )
          return undefined;
        const record = recordLinkValueSchema.safeParse(operand.value);
        return record.success ? value("text", record.data.recordId) : undefined;
      }
      case "add":
      case "multiply":
      case "subtract":
      case "divide": {
        const operands = node.args.map(evaluate);
        return operands.some((operand) => operand === undefined)
          ? undefined
          : arithmetic(
              node.op,
              operands as FlowRuntimeValue[],
              node.scale,
              node.rounding,
              exactValues,
              options.preserveExactArithmetic === true,
            );
      }
      case "round": {
        const operand = evaluate(node.arg);
        if (operand === undefined) return undefined;
        const rounded = arithmetic(
          "add",
          [{ type: operand.type, value: operand.value }],
          node.scale,
          node.rounding,
          exactValues,
          false,
        );
        if (rounded === undefined) return undefined;
        if (operand.type === "whole_number") {
          const whole = Number(rounded.value);
          return Number.isSafeInteger(whole) ? value("whole_number", whole) : undefined;
        }
        return value(operand.type, rounded.value);
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
          if (!isTextType(left.type) || !isTextType(right.type)) return undefined;
          return yesNo(
            node.op === "contains"
              ? left.value.includes(right.value)
              : node.op === "starts_with"
                ? left.value.startsWith(right.value)
                : left.value.endsWith(right.value),
          );
        }
        if (node.op === "contains" && Array.isArray(left.value))
          return yesNo(left.value.some((item) => flowJsonValuesEqual(item, right.value)));
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
      case "deadline_passed": {
        if (node.status !== undefined) {
          const status = evaluate(node.status);
          if (status === undefined || !isTextType(status.type)) return undefined;
          if (
            node.terminalStatusValues.some((candidate) =>
              flowJsonValuesEqual(candidate, status.value),
            )
          )
            return yesNo(false);
        }
        const due = evaluate(node.due);
        if (due === undefined || due.value === null) return undefined;
        if (due.type === "date") {
          if (typeof due.value !== "string" || scope.organizationLocalDate === undefined)
            return undefined;
          return yesNo(due.value < scope.organizationLocalDate);
        }
        if (due.type !== "date_time") return undefined;
        const order = compare(due, value("date_time", scope.now));
        return typeof order === "number" ? yesNo(order <= 0) : undefined;
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
  const evaluated = evaluate(formula);
  if (evaluated === undefined) return undefined;
  const result =
    options.resultScale !== undefined &&
    (evaluated.type === "decimal_number" || evaluated.type === "money")
      ? arithmetic(
          "add",
          [evaluated],
          options.resultScale,
          "rounding" in formula ? formula.rounding : "half_even",
          exactValues,
          false,
        )
      : evaluated;
  if (result === undefined) return undefined;
  if (options.requireExactInteger) {
    const exact = exactValues.get(result);
    if (exact !== undefined) {
      if (exact.numerator % exact.denominator !== 0n) return undefined;
    } else if (decimalOf(result)?.scale !== 0) return undefined;
  }
  return result;
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

/** A location in a formula, relative to its containing definition. */
export type FlowFormulaPath = (string | number)[];

export type FlowFormulaCheckOptions = Readonly<{
  nowAllowed: boolean;
  /** A record money literal cannot carry a currency. */
  moneyLiterals?: boolean;
  reference: (reference: FlowReference, path: FlowFormulaPath) => string | undefined;
  issue: (
    path: FlowFormulaPath,
    rule: "vortex.definition.source_type_compatibility" | "vortex.definition.workflow_node_values",
    family: "invalid_value",
    message: string,
  ) => void;
}>;

const numericTypes: ReadonlySet<string> = new Set(["whole_number", "decimal_number", "money"]);
const dateTypes: ReadonlySet<string> = new Set(["date", "date_time"]);

/** Checks a formula against its reference environment and reports errors at their exact paths. */
export const checkFlowFormula = (
  formula: FlowFormula,
  options: FlowFormulaCheckOptions,
  path: FlowFormulaPath = [],
): string | undefined => {
  const add = options.issue;
  const child = (value: FlowFormula, ...segments: (string | number)[]) =>
    checkFlowFormula(value, options, [...path, ...segments]);
  const expect = (
    actual: string | undefined,
    accepted: (type: string) => boolean,
    childPath: FlowFormulaPath,
    wanted: string,
  ) => {
    if (actual === undefined || actual === "json" || accepted(actual)) return;
    add(
      childPath,
      "vortex.definition.source_type_compatibility",
      "invalid_value",
      `Expected ${wanted}, found ${actual}`,
    );
  };
  const numericArgs = (
    args: readonly FlowFormula[],
    segment: string,
    operation: "add" | "subtract" | "multiply" | "divide",
  ): string | undefined => {
    const types = args.map((arg, index) => {
      const type = child(arg, segment, index);
      expect(
        type,
        (candidate) => numericTypes.has(candidate),
        [...path, segment, index],
        "a number",
      );
      return type;
    });
    const money = types.flatMap((type, index) => (type === "money" ? [index] : []));
    if (
      ((operation === "add" || operation === "subtract") &&
        money.length > 0 &&
        money.length !== types.length) ||
      (operation === "multiply" && money.length > 1) ||
      (operation === "divide" && money.length > 0 && (money.length !== 1 || money[0] !== 0))
    ) {
      add(
        path,
        "vortex.definition.source_type_compatibility",
        "invalid_value",
        "These money operands cannot be combined",
      );
      return undefined;
    }
    return types.includes("money")
      ? "money"
      : types.some((type) => type === undefined || type === "json")
        ? undefined
        : types.includes("decimal_number")
          ? "decimal_number"
          : "whole_number";
  };
  switch (formula.op) {
    case "literal":
      if (formula.type === "money" && options.moneyLiterals === false) {
        add(
          path,
          "vortex.definition.source_type_compatibility",
          "invalid_value",
          "A money literal must carry its currency",
        );
        return undefined;
      }
      return formula.type;
    case "reference":
      return options.reference(formula.reference, [...path, "reference"]);
    case "record_id": {
      const type = child(formula.arg, "arg");
      if (type !== "json") {
        add(
          [...path, "arg"],
          "vortex.definition.source_type_compatibility",
          "invalid_value",
          `The record_id operand must have a declared JSON type, found ${type ?? "an unknown type"}`,
        );
        return undefined;
      }
      return "text";
    }
    case "deadline_passed":
      if (!options.nowAllowed)
        add(
          path,
          "vortex.definition.workflow_node_values",
          "invalid_value",
          "A deadline uses the current time",
        );
      expect(
        child(formula.due, "due"),
        (type) => dateTypes.has(type),
        [...path, "due"],
        "a date or date-time deadline",
      );
      if (formula.status !== undefined)
        expect(
          child(formula.status, "status"),
          (type) => type === "text" || type === "choice",
          [...path, "status"],
          "a status",
        );
      return "yes_no";
    case "now":
      if (!options.nowAllowed)
        add(
          path,
          "vortex.definition.workflow_node_values",
          "invalid_value",
          "The now operator is allowed only in interactive and background flows, and never in a trigger",
        );
      return "date_time";
    case "add":
    case "multiply":
    case "subtract": {
      const type = numericArgs(formula.args, "args", formula.op);
      return type === "whole_number" && formula.scale > 0 ? "decimal_number" : type;
    }
    case "divide": {
      const type = numericArgs(formula.args, "args", formula.op);
      return type === "money" ? "money" : type === undefined ? undefined : "decimal_number";
    }
    case "round": {
      const type = child(formula.arg, "arg");
      expect(type, (candidate) => numericTypes.has(candidate), [...path, "arg"], "a number");
      return type;
    }
    case "eq":
    case "neq":
    case "lt":
    case "lte":
    case "gt":
    case "gte":
    case "contains":
    case "starts_with":
    case "ends_with": {
      const left = child(formula.left, "left");
      const right = child(formula.right, "right");
      if (
        left !== undefined &&
        right !== undefined &&
        left !== "json" &&
        right !== "json" &&
        !valueTypesCompatible(left, right, "condition") &&
        !valueTypesCompatible(right, left, "condition")
      )
        add(
          path,
          "vortex.definition.source_type_compatibility",
          "invalid_value",
          `Cannot compare ${left} with ${right}`,
        );
      return "yes_no";
    }
    case "is_empty":
    case "is_not_empty":
      child(formula.arg, "arg");
      return "yes_no";
    case "in": {
      const value = child(formula.value, "value");
      formula.options.forEach((option, index) => {
        const type = child(option, "options", index);
        if (
          value !== undefined &&
          type !== undefined &&
          value !== "json" &&
          type !== "json" &&
          !valueTypesCompatible(type, value, "condition")
        )
          add(
            [...path, "options", index],
            "vortex.definition.source_type_compatibility",
            "invalid_value",
            `An option of type ${type} cannot be compared with ${value}`,
          );
      });
      return "yes_no";
    }
    case "and":
    case "or":
      formula.args.forEach((arg, index) =>
        expect(
          child(arg, "args", index),
          (type) => type === "yes_no",
          [...path, "args", index],
          "a yes/no value",
        ),
      );
      return "yes_no";
    case "not":
      expect(
        child(formula.arg, "arg"),
        (type) => type === "yes_no",
        [...path, "arg"],
        "a yes/no value",
      );
      return "yes_no";
    case "if": {
      expect(
        child(formula.condition, "condition"),
        (type) => type === "yes_no",
        [...path, "condition"],
        "a yes/no value",
      );
      const then = child(formula.then, "then");
      const otherwise = child(formula.else, "else");
      if (then === undefined || otherwise === undefined || then === "json" || otherwise === "json")
        return undefined;
      if (then === otherwise) return then;
      if (
        (then === "whole_number" || then === "decimal_number") &&
        (otherwise === "whole_number" || otherwise === "decimal_number")
      )
        return "decimal_number";
      add(
        [...path, "else"],
        "vortex.definition.source_type_compatibility",
        "invalid_value",
        `Both results of if must have one type, found ${then} and ${otherwise}`,
      );
      return undefined;
    }
    case "join":
      formula.parts.forEach((part, index) => child(part, "parts", index));
      return "text";
    case "date_add": {
      const date = child(formula.date, "date");
      expect(date, (type) => dateTypes.has(type), [...path, "date"], "a date or date and time");
      expect(
        child(formula.amount, "amount"),
        (type) => type === "whole_number",
        [...path, "amount"],
        "a whole number",
      );
      return date;
    }
    case "date_diff":
      expect(
        child(formula.from, "from"),
        (type) => dateTypes.has(type),
        [...path, "from"],
        "a date or date and time",
      );
      expect(
        child(formula.to, "to"),
        (type) => dateTypes.has(type),
        [...path, "to"],
        "a date or date and time",
      );
      return "whole_number";
  }
};
