import type { JsonValue } from "@vortex/contracts";

export type ResolvedTypedConditionOperand<TType extends string> = Readonly<{
  type?: TType;
  literal?: JsonValue;
  value: JsonValue;
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
