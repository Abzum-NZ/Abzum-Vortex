import type { JsonValue } from "@vortex/contracts";

export type ResolvedTypedConditionOperand<TType extends string> = Readonly<{
  type?: TType;
  literal?: JsonValue;
  value: JsonValue;
}>;

type TypedConditionSemantics<
  TType extends string,
  TOperand extends ResolvedTypedConditionOperand<TType>,
  TSourceOperand,
> = Readonly<{
  resolveOperand: (entry: TSourceOperand) => TOperand;
  validateComparison: (operator: string, left: TOperand, right: TOperand | undefined) => void;
  evaluateComparison: (operator: string, left: TOperand, right: TOperand | undefined) => boolean;
}>;

export type ResolvedTypedConditionNode<TOperand = unknown> =
  | Readonly<{
      kind: "comparison";
      operator: string;
      left: TOperand;
      right?: TOperand;
    }>
  | Readonly<{
      kind: "all" | "any";
      conditions: readonly ResolvedTypedConditionNode<TOperand>[];
    }>
  | Readonly<{
      kind: "not";
      condition: ResolvedTypedConditionNode<TOperand>;
    }>;

export const validText = (value: unknown): value is string => {
  if (typeof value !== "string" || value.includes("\0")) return false;
  return [...value].every((entry) => {
    const point = entry.codePointAt(0)!;
    return point < 0xd800 || point > 0xdfff;
  });
};

export const validDate = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
};

export const instantMicros = (value: unknown): bigint | undefined => {
  if (typeof value !== "string") return undefined;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const local = new Date(0);
  local.setUTCHours(hour, minute, second, 0);
  local.setUTCFullYear(year, month - 1, day);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day
  )
    return undefined;
  const zone = match[8]!;
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetRemainder = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetRemainder > 59) return undefined;
    offsetMinutes = (offsetHours * 60 + offsetRemainder) * (zone[0] === "+" ? 1 : -1);
  }
  const fractionalMicros = BigInt((match[7] ?? "").padEnd(6, "0"));
  return BigInt(local.getTime() - offsetMinutes * 60_000) * 1_000n + fractionalMicros;
};

export const exactJsonEqual = (left: JsonValue, right: JsonValue): boolean => {
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object")
    return left === right;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => exactJsonEqual(entry, right[index]!))
    );
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && exactJsonEqual(left[key]!, right[rightKeys[index]!]!),
    )
  );
};

export const codePointCompare = (left: string, right: string): number => {
  const leftPoints = [...left].map((entry) => entry.codePointAt(0)!);
  const rightPoints = [...right].map((entry) => entry.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
};

/** Runs the shared, validate-before-evaluate condition traversal for a semantic adapter. */
export const evaluateResolvedTypedCondition = <
  TType extends string,
  TOperand extends ResolvedTypedConditionOperand<TType>,
  TSourceOperand = unknown,
>(
  condition: ResolvedTypedConditionNode<TSourceOperand>,
  semantics: TypedConditionSemantics<TType, TOperand, TSourceOperand>,
): boolean => {
  const validate = (node: ResolvedTypedConditionNode<TSourceOperand>): void => {
    if (node.kind === "all" || node.kind === "any") {
      node.conditions.forEach(validate);
      return;
    }
    if (node.kind === "not") {
      validate(node.condition);
      return;
    }
    if (node.kind !== "comparison") return;
    semantics.validateComparison(
      node.operator,
      semantics.resolveOperand(node.left),
      node.right === undefined ? undefined : semantics.resolveOperand(node.right),
    );
  };

  const evaluate = (node: ResolvedTypedConditionNode<TSourceOperand>): boolean => {
    if (node.kind === "all") return node.conditions!.map(evaluate).every(Boolean);
    if (node.kind === "any") return node.conditions!.map(evaluate).some(Boolean);
    if (node.kind === "not") return !evaluate(node.condition!);
    if (node.kind !== "comparison") return false;
    return semantics.evaluateComparison(
      node.operator,
      semantics.resolveOperand(node.left),
      node.right === undefined ? undefined : semantics.resolveOperand(node.right),
    );
  };

  validate(condition);
  return evaluate(condition);
};
