import type {
  ApplicationSourceDocument,
  ConditionNode,
  InlineModuleActionPrecondition,
  JsonValue,
} from "@vortex/platform/schema";
import type {
  StudioConditionControlsContext,
  StudioConditionParameterType,
} from "./condition-model";
import { studioFieldChoiceOptions, studioFieldValueType } from "./application-flow-values";

/**
 * A named action's precondition in Studio's shared condition controls. The action stores its
 * precondition as the authored condition over its record's fields by key; the controls edit the
 * shared condition tree, where each field is one operand. This module turns one into the other. A
 * condition the controls cannot show (a comparison with an action input or between two fields) is
 * reported as such and kept until it is replaced.
 */

type RecordType = ApplicationSourceDocument["body"]["modules"][number]["record_types"][number];
type Comparison = Extract<ConditionNode, { kind: "comparison" }>;
type Inputs = ApplicationSourceDocument["body"]["modules"][number]["actions"][number]["inputs"];

const actionOperands = (record: RecordType, inputs: Inputs) => [
  ...record.fields.map((field, index) => ({
    key: `field_${index + 1}`,
    source: { source: "field" as const, field: field.key },
  })),
  ...inputs.map((input, index) => ({
    key: `input_${index + 1}`,
    source: { source: "parameter" as const, parameter: input.key },
  })),
];

const parameterType = (fieldType: string): StudioConditionParameterType => {
  switch (studioFieldValueType(fieldType)) {
    case "whole_number":
      return "whole_number";
    case "decimal_number":
      return "decimal_number";
    case "money":
      return "money";
    case "yes_no":
      return "yes_no";
    case "date":
      return "date";
    case "date_time":
      return "date_time";
    case "organization_account_reference":
      return "organization_account_reference";
    default:
      return "text";
  }
};

/** The fields a precondition can compare, each as one operand named by the field's key. */
export const studioActionConditionContext = (
  record: RecordType,
  inputs: Inputs,
): StudioConditionControlsContext => ({
  allowedOperands: [
    ...record.fields.map((field, index) => {
      const options = studioFieldChoiceOptions(field);
      return {
        operand: { source: "parameter" as const, key: `field_${index + 1}` },
        label: field.label,
        role: "record_field" as const,
        ...(options === undefined ? {} : { options }),
      };
    }),
    ...inputs.map((input, index) => ({
      operand: { source: "parameter" as const, key: `input_${index + 1}` },
      label: input.label,
      role: "declared_input" as const,
    })),
  ],
  declaredFieldIds: [],
  parameterDeclarations: [
    ...record.fields.map((field, index) => ({
      key: `field_${index + 1}`,
      type: parameterType(field.type),
    })),
    ...inputs.map((input, index) => ({
      key: `input_${index + 1}`,
      type: parameterType(input.type),
    })),
  ],
  allowLiteralValues: true,
});

/** The tree the controls show, or "unsupported" for a precondition they cannot show. */
export const projectStudioActionCondition = (
  condition: InlineModuleActionPrecondition | undefined,
  record: RecordType,
  inputs: Inputs,
):
  | Readonly<{ kind: "condition"; condition: ConditionNode | undefined }>
  | Readonly<{ kind: "unsupported" }> => {
  const operands = actionOperands(record, inputs);
  const fieldOperand = (field: string): Comparison["left"] | undefined => {
    const found = operands.find(
      (entry) => entry.source.source === "field" && entry.source.field === field,
    );
    return found === undefined ? undefined : { source: "parameter", key: found.key };
  };
  const node = (part: unknown): ConditionNode | undefined => {
    if (part === null || typeof part !== "object") return undefined;
    const entry = part as Record<string, unknown>;
    if (Array.isArray(entry.all) || Array.isArray(entry.any)) {
      const children = ((entry.all ?? entry.any) as unknown[]).map(node);
      return children.every((child) => child !== undefined)
        ? {
            kind: Array.isArray(entry.all) ? "all" : "any",
            conditions: children as ConditionNode[],
          }
        : undefined;
    }
    if (entry.not !== undefined) {
      const inner = node(entry.not);
      return inner === undefined ? undefined : { kind: "not", condition: inner };
    }
    const operator = entry.operator as Comparison["operator"];
    const operand = (side: unknown): Comparison["left"] | undefined => {
      const value = side as Record<string, unknown> | undefined;
      return value?.source === "field" && typeof value.field === "string"
        ? fieldOperand(value.field)
        : value?.source === "value"
          ? { source: "value", value: value.value as JsonValue }
          : undefined;
    };
    const left = typeof entry.field === "string" ? fieldOperand(entry.field) : operand(entry.left);
    if (left === undefined) return undefined;
    if (operator === "is_empty" || operator === "is_not_empty")
      return { kind: "comparison", operator, left };
    const right =
      typeof entry.parameter === "string"
        ? (() => {
            const found = operands.find(
              (part) =>
                part.source.source === "parameter" && part.source.parameter === entry.parameter,
            );
            return found === undefined
              ? undefined
              : { source: "parameter" as const, key: found.key };
          })()
        : Object.hasOwn(entry, "value")
          ? { source: "value" as const, value: entry.value as JsonValue }
          : operand(entry.right);
    return right === undefined ? undefined : { kind: "comparison", operator, left, right };
  };
  if (condition === undefined) return { kind: "condition", condition: undefined };
  const projected = node(condition);
  return projected === undefined
    ? { kind: "unsupported" }
    : { kind: "condition", condition: projected };
};

/** The authored precondition for an edited tree, or undefined when a comparison is not finished. */
export const studioActionConditionSource = (
  condition: ConditionNode | undefined,
  record: RecordType,
  inputs: Inputs,
):
  | Readonly<{ ok: true; condition: InlineModuleActionPrecondition | undefined }>
  | Readonly<{ ok: false }> => {
  const operands = actionOperands(record, inputs);
  const source = (node: ConditionNode): unknown => {
    if (node.kind === "all" || node.kind === "any") {
      const children = node.conditions.map(source);
      return children.some((child) => child === undefined)
        ? undefined
        : node.kind === "all"
          ? { all: children }
          : { any: children };
    }
    if (node.kind === "not") {
      const inner = source(node.condition);
      return inner === undefined ? undefined : { not: inner };
    }
    if (node.kind !== "comparison") return undefined;
    const operand = (side: Comparison["left"]) =>
      side.source === "parameter"
        ? operands.find((entry) => entry.key === side.key)?.source
        : side.source === "value"
          ? { source: "value", value: side.value }
          : undefined;
    const left = operand(node.left);
    if (node.operator === "is_empty" || node.operator === "is_not_empty")
      return left?.source === "field" ? { field: left.field, operator: node.operator } : undefined;
    if (node.right === undefined) return undefined;
    const right = operand(node.right);
    if (left?.source === "field" && right?.source === "parameter")
      return { field: left.field, operator: node.operator, parameter: right.parameter };
    if (left?.source === "field" && node.right.source === "value")
      return node.right.value === null
        ? undefined
        : { field: left.field, operator: node.operator, value: node.right.value };
    return left === undefined || right === undefined
      ? undefined
      : { operator: node.operator, left, right };
  };
  if (condition === undefined) return { ok: true, condition: undefined };
  const built = source(condition);
  return built === undefined
    ? { ok: false }
    : { ok: true, condition: built as InlineModuleActionPrecondition };
};
