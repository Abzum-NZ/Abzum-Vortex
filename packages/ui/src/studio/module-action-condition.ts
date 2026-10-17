import type { ApplicationSourceDocument, ConditionNode, InlineModuleActionPrecondition, JsonValue } from "@vortex/platform/schema";
import type { StudioConditionControlsContext, StudioConditionParameterType } from "./condition-model";
import { studioFieldValueType } from "./application-flow-values";

/**
 * A named action's precondition in Studio's shared condition controls. The action stores its
 * precondition as the authored condition over its record's fields by key; the controls edit the
 * shared condition tree, where each field is one operand. This module turns one into the other. A
 * condition the controls cannot show (a comparison with an action input or between two fields) is
 * reported as such and kept until it is replaced.
 */

type RecordType = ApplicationSourceDocument["body"]["modules"][number]["record_types"][number];
type Comparison = Extract<ConditionNode, { kind: "comparison" }>;

const parameterType = (fieldType: string): StudioConditionParameterType => {
  switch (studioFieldValueType(fieldType)) {
    case "whole_number": return "number";
    case "decimal_number": return "decimal_number";
    case "money": return "money";
    case "yes_no": return "boolean";
    case "date": return "date";
    case "date_time": return "date_time";
    case "organization_account_reference": return "organization_account_reference";
    default: return "text";
  }
};

/** The fields a precondition can compare, each as one operand named by the field's key. */
export const studioActionConditionContext = (record: RecordType): StudioConditionControlsContext => ({
  allowedOperands: record.fields.map((field) => ({ operand: { source: "parameter" as const, key: field.key },
    label: field.label, role: "record_field" as const })),
  declaredFieldIds: [],
  parameterDeclarations: record.fields.map((field) => ({ key: field.key, type: parameterType(field.type) })),
  allowLiteralValues: true,
});

/** The tree the controls show, or "unsupported" for a precondition they cannot show. */
export const projectStudioActionCondition = (condition: InlineModuleActionPrecondition | undefined):
  Readonly<{ kind: "condition"; condition: ConditionNode | undefined }> | Readonly<{ kind: "unsupported" }> => {
  const node = (part: unknown): ConditionNode | undefined => {
    if (part === null || typeof part !== "object") return undefined;
    const entry = part as Record<string, unknown>;
    if (Array.isArray(entry.all) || Array.isArray(entry.any)) {
      const children = ((entry.all ?? entry.any) as unknown[]).map(node);
      return children.every((child) => child !== undefined)
        ? { kind: Array.isArray(entry.all) ? "all" : "any", conditions: children as ConditionNode[] } : undefined;
    }
    if (entry.not !== undefined) { const inner = node(entry.not); return inner === undefined ? undefined : { kind: "not", condition: inner }; }
    const operator = entry.operator as Comparison["operator"];
    const operand = (side: unknown): Comparison["left"] | undefined => {
      const value = side as Record<string, unknown> | undefined;
      return value?.source === "field" && typeof value.field === "string" ? { source: "parameter", key: value.field }
        : value?.source === "value" ? { source: "value", value: value.value as JsonValue } : undefined;
    };
    const left = typeof entry.field === "string" ? { source: "parameter" as const, key: entry.field } : operand(entry.left);
    if (left === undefined) return undefined;
    if (operator === "is_empty" || operator === "is_not_empty") return { kind: "comparison", operator, left };
    const right = Object.hasOwn(entry, "value") ? { source: "value" as const, value: entry.value as JsonValue } : operand(entry.right);
    return right === undefined ? undefined : { kind: "comparison", operator, left, right };
  };
  if (condition === undefined) return { kind: "condition", condition: undefined };
  const projected = node(condition);
  return projected === undefined ? { kind: "unsupported" } : { kind: "condition", condition: projected };
};

/** The authored precondition for an edited tree, or undefined when a comparison is not finished. */
export const studioActionConditionSource = (condition: ConditionNode | undefined):
  Readonly<{ ok: true; condition: InlineModuleActionPrecondition | undefined }> | Readonly<{ ok: false }> => {
  const source = (node: ConditionNode): unknown => {
    if (node.kind === "all" || node.kind === "any") {
      const children = node.conditions.map(source);
      return children.some((child) => child === undefined) ? undefined : node.kind === "all" ? { all: children } : { any: children };
    }
    if (node.kind === "not") { const inner = source(node.condition); return inner === undefined ? undefined : { not: inner }; }
    if (node.kind !== "comparison") return undefined;
    const operand = (side: Comparison["left"]) => side.source === "parameter" ? { source: "field", field: side.key }
      : side.source === "value" ? { source: "value", value: side.value } : undefined;
    if (node.operator === "is_empty" || node.operator === "is_not_empty")
      return node.left.source === "parameter" ? { field: node.left.key, operator: node.operator } : undefined;
    if (node.right === undefined) return undefined;
    if (node.left.source === "parameter" && node.right.source === "value")
      return node.right.value === null ? undefined : { field: node.left.key, operator: node.operator, value: node.right.value };
    const left = operand(node.left);
    const right = operand(node.right);
    return left === undefined || right === undefined ? undefined : { operator: node.operator, left, right };
  };
  if (condition === undefined) return { ok: true, condition: undefined };
  const built = source(condition);
  return built === undefined ? { ok: false } : { ok: true, condition: built as InlineModuleActionPrecondition };
};
