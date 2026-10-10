import {
  canonicalJson,
  conditionNodeSchema,
  sourceConditionSchema,
  type ConditionNode,
  type JsonValue,
  type SourceCondition,
} from "@vortex/contracts";
import type { ModuleQueryFilterDraftContext } from "@vortex/definition";
import type { StudioConditionControlsContext } from "@vortex/studio";

type ModuleConditionOperand = Extract<ConditionNode, { kind: "comparison" }>["left"];

export type ModuleQueryFilterMappingResult =
  | Readonly<{ kind: "available"; filter: SourceCondition | null }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "unsupported" }>;

/** Build the shared control allowlist from a server-resolved current Module context. */
export const moduleQueryFilterControlsContext = (
  context: ModuleQueryFilterDraftContext,
): StudioConditionControlsContext => ({
  allowedOperands: [
    ...context.fields.map(({ field }) => ({
      operand: { source: "field" as const, fieldId: field.fieldId },
      field,
      label: field.label,
      role: "current_field" as const,
    })),
    ...context.parameters.map((parameter) => ({
      operand: { source: "parameter" as const, key: parameter.key },
      label: parameter.key,
      role: "declared_input" as const,
    })),
  ],
  declaredFieldIds: context.fields.map(({ field }) => field.fieldId),
  parameterDeclarations: context.parameters,
  allowLiteralValues: true,
});

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
    return sourceConditionSchema.parse(condition.kind === "all" ? { all: children } : { any: children });
  }
  const encodeOperand = (operand: ModuleConditionOperand):
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

export const sameModuleQueryFilter = (
  left: ConditionNode | null,
  right: ConditionNode | null,
): boolean => canonicalJson(left) === canonicalJson(right);
