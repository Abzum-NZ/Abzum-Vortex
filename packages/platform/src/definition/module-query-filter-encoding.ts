import {
  conditionNodeSchema,
  sourceConditionSchema,
  type ConditionNode,
  type JsonValue,
  type ModuleSourceDocument,
} from "../schema";
import type { ModuleQueryFilterDraftContext } from "./definition-publication";

type ModuleSourceQuery = ModuleSourceDocument["body"]["queries"][number];
type SourceCondition = NonNullable<ModuleSourceQuery["filter"]>;
type ModuleConditionOperand = Extract<ConditionNode, { kind: "comparison" }>["left"];
export type ModuleQueryFilterMappingResult =
  | Readonly<{ kind: "available"; filter: SourceCondition | null }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "unsupported" }>;
const encodeCondition = (
  condition: ConditionNode,
  context: ModuleQueryFilterDraftContext,
): SourceCondition | undefined => {
  if (condition.kind === "not") {
    const child = encodeCondition(condition.condition, context);
    return child === undefined ? undefined : { not: child };
  }
  if (condition.kind === "all" || condition.kind === "any") {
    const children: SourceCondition[] = [];
    for (const child of condition.conditions) {
      const encoded = encodeCondition(child, context);
      if (encoded === undefined) return undefined;
      children.push(encoded);
    }
    return sourceConditionSchema.parse(
      condition.kind === "all" ? { all: children } : { any: children },
    );
  }
  if (condition.kind !== "comparison") return undefined;
  const encodeOperand = (
    operand: ModuleConditionOperand,
  ):
    | Readonly<{ source: "field"; field: string }>
    | Readonly<{ source: "value"; value: JsonValue }>
    | Readonly<{ source: "parameter"; parameter: string }>
    | undefined => {
    if (operand.source === "field") {
      const matches = context.fields.filter((entry) => entry.field.fieldId === operand.fieldId);
      return matches.length === 1 ? { source: "field", field: matches[0]!.sourceKey } : undefined;
    }
    if (operand.source === "parameter")
      return context.parameters.some((entry) => entry.key === operand.key)
        ? { source: "parameter", parameter: operand.key }
        : undefined;
    return { source: "value", value: operand.value };
  };
  const left = encodeOperand(condition.left);
  if (left === undefined) return undefined;
  if (condition.operator === "is_empty" || condition.operator === "is_not_empty")
    return sourceConditionSchema.parse({ operator: condition.operator, left });
  if (condition.right === undefined) return undefined;
  const right = encodeOperand(condition.right);
  return right === undefined
    ? undefined
    : sourceConditionSchema.parse({ operator: condition.operator, left, right });
};

/** Emit only the strict current SourceCondition grammar; no compiled UUID enters authored JSON. */
export const encodeModuleQueryFilter = (
  candidate: unknown,
  context: ModuleQueryFilterDraftContext,
): ModuleQueryFilterMappingResult => {
  if (candidate === null) return { kind: "available", filter: null };
  const condition = conditionNodeSchema.safeParse(candidate);
  if (!condition.success) return { kind: "invalid" };
  try {
    const encoded = encodeCondition(condition.data, context);
    if (encoded === undefined) return { kind: "unsupported" };
    const parsed = sourceConditionSchema.safeParse(encoded);
    return parsed.success ? { kind: "available", filter: parsed.data } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
};
