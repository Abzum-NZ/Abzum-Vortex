import type { ConditionNode, FlowFormula, FlowLiteral, JsonValue } from "@vortex/platform/schema";
import type {
  StudioConditionControlsContext,
  StudioConditionOperandRole,
  StudioConditionParameterType,
} from "./condition-model";
import {
  studioFlowReferenceToken,
  type StudioFlowReferenceChoice,
} from "./application-flow-values";

/**
 * A flow decision's condition in Studio's shared condition controls. The flow stores its condition
 * as a typed formula; the controls edit the shared condition tree. Each reference the step can read
 * is one operand (a parameter of the controls), and this module turns the stored formula into the
 * tree the controls show and the edited tree back into the formula the flow stores. A formula the
 * controls cannot show (arithmetic, dates, nested ifs) is reported, never guessed.
 */

type Comparison = Extract<ConditionNode, { kind: "comparison" }>;
type Operand = Comparison["left"];

export type StudioFlowConditionContext = Readonly<{
  controls: StudioConditionControlsContext;
  /** The parameter key of each reference token, and back. */
  keys: ReadonlyMap<string, string>;
  choices: ReadonlyMap<string, StudioFlowReferenceChoice>;
}>;

const parameterType = (type: string | undefined): StudioConditionParameterType => {
  switch (type) {
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

const roles: Readonly<
  Record<StudioFlowReferenceChoice["group"], Exclude<StudioConditionOperandRole, "current_field">>
> = {
  "Flow inputs": "declared_input",
  "From the triggering event": "event_value",
  "Saved values": "variable",
  "Earlier steps": "step_output",
  "The record": "record_field",
  "Page values": "host_context",
  "Form fields": "host_context",
  "The run": "run_value",
};

/** The controls' context for a condition that may read these references, and literal values. */
export const studioFlowConditionContext = (
  choices: readonly StudioFlowReferenceChoice[],
): StudioFlowConditionContext => {
  const keys = new Map<string, string>();
  const byKey = new Map<string, StudioFlowReferenceChoice>();
  choices.forEach((choice, index) => {
    const key = `ref_${index + 1}`;
    keys.set(choice.token, key);
    byKey.set(key, choice);
  });
  return {
    keys,
    choices: byKey,
    controls: {
      allowedOperands: choices.map((choice) => ({
        operand: { source: "parameter" as const, key: keys.get(choice.token)! },
        label: choice.label,
        role: roles[choice.group],
        ...(choice.options === undefined ? {} : { options: choice.options }),
      })),
      declaredFieldIds: [],
      parameterDeclarations: choices.map((choice) => ({
        key: keys.get(choice.token)!,
        type: parameterType(choice.type),
      })),
      allowLiteralValues: true,
    },
  };
};

const operators: Readonly<Record<string, Comparison["operator"]>> = {
  eq: "equals",
  neq: "not_equals",
  lt: "less_than",
  lte: "less_than_or_equal",
  gt: "greater_than",
  gte: "greater_than_or_equal",
  contains: "contains",
};

type Projected =
  | Readonly<{ kind: "condition"; condition: ConditionNode | undefined }>
  | Readonly<{ kind: "unsupported" }>;

/** The tree the controls show for a stored formula; a formula that always holds shows no condition. */
export const projectStudioFlowCondition = (
  formula: FlowFormula,
  context: StudioFlowConditionContext,
): Projected => {
  const unsupported = { kind: "unsupported" } as const;
  if (formula.op === "literal" && formula.type === "yes_no" && formula.value === true)
    return { kind: "condition", condition: undefined };
  const operand = (part: FlowFormula): Operand | undefined => {
    if (part.op === "literal") return { source: "value", value: part.value };
    if (part.op !== "reference") return undefined;
    const key = context.keys.get(studioFlowReferenceToken(part.reference));
    return key === undefined ? undefined : { source: "parameter", key };
  };
  const node = (part: FlowFormula): ConditionNode | undefined => {
    switch (part.op) {
      case "and":
      case "or": {
        const children = part.args.map(node);
        return children.every((child) => child !== undefined)
          ? { kind: part.op === "and" ? "all" : "any", conditions: children as ConditionNode[] }
          : undefined;
      }
      case "not": {
        const inner = node(part.arg);
        if (
          inner?.kind === "comparison" &&
          (inner.operator === "contains" || inner.operator === "in")
        )
          return { ...inner, operator: inner.operator === "contains" ? "not_contains" : "not_in" };
        return inner === undefined ? undefined : { kind: "not", condition: inner };
      }
      case "is_empty":
      case "is_not_empty": {
        const left = operand(part.arg);
        return left === undefined ? undefined : { kind: "comparison", operator: part.op, left };
      }
      case "in": {
        const left = operand(part.value);
        const values = part.options.map((option) =>
          option.op === "literal" ? option.value : undefined,
        );
        return left === undefined || values.some((value) => value === undefined)
          ? undefined
          : {
              kind: "comparison",
              operator: "in",
              left,
              right: { source: "value", value: values as JsonValue[] },
            };
      }
      case "eq":
      case "neq":
      case "lt":
      case "lte":
      case "gt":
      case "gte":
      case "contains": {
        const left = operand(part.left);
        const right = operand(part.right);
        return left === undefined || right === undefined
          ? undefined
          : { kind: "comparison", operator: operators[part.op]!, left, right };
      }
      case "reference": {
        // A yes/no reference on its own reads as "is yes".
        const left = operand(part);
        return left === undefined
          ? undefined
          : {
              kind: "comparison",
              operator: "equals",
              left,
              right: { source: "value", value: true },
            };
      }
      default:
        return undefined;
    }
  };
  const condition = node(formula);
  return condition === undefined ? unsupported : { kind: "condition", condition };
};

const literalTypeFor = (declared: string | undefined, value: JsonValue): FlowLiteral["type"] => {
  if (typeof value === "boolean") return "yes_no";
  if (typeof value === "number") return Number.isInteger(value) ? "whole_number" : "decimal_number";
  if (Array.isArray(value)) return "several_choices";
  if (
    typeof value === "string" &&
    declared !== undefined &&
    [
      "choice",
      "date",
      "date_time",
      "decimal_number",
      "organization_account_reference",
      "record_reference",
    ].includes(declared)
  )
    return declared as FlowLiteral["type"];
  return typeof value === "string" ? "text" : "json";
};

/** The stored formula for an edited tree; no condition means the decision always takes its first branch. */
export const studioFlowConditionFormula = (
  condition: ConditionNode | undefined,
  context: StudioFlowConditionContext,
): FlowFormula | undefined => {
  if (condition === undefined) return { op: "literal", type: "yes_no", value: true };
  const typeOf = (other: Operand | undefined): string | undefined =>
    other?.source === "parameter" ? context.choices.get(other.key)?.type : undefined;
  const operand = (part: Operand, other: Operand | undefined): FlowFormula | undefined => {
    if (part.source === "parameter") {
      const choice = context.choices.get(part.key);
      return choice === undefined ? undefined : { op: "reference", reference: choice.reference };
    }
    if (part.source !== "value" || part.value === null) return undefined;
    return { op: "literal", type: literalTypeFor(typeOf(other), part.value), value: part.value };
  };
  const formula = (node: ConditionNode): FlowFormula | undefined => {
    if (node.kind === "all" || node.kind === "any") {
      const args = node.conditions.map(formula);
      if (args.some((arg) => arg === undefined)) return undefined;
      return args.length === 1
        ? args[0]
        : { op: node.kind === "all" ? "and" : "or", args: args as FlowFormula[] };
    }
    if (node.kind === "not") {
      const inner = formula(node.condition);
      return inner === undefined ? undefined : { op: "not", arg: inner };
    }
    if (node.kind !== "comparison") return undefined;
    const left = operand(node.left, node.right);
    if (left === undefined) return undefined;
    if (node.operator === "is_empty" || node.operator === "is_not_empty")
      return { op: node.operator, arg: left };
    if (node.right === undefined) return undefined;
    if (node.operator === "in" || node.operator === "not_in") {
      const values =
        node.right.source === "value" && Array.isArray(node.right.value)
          ? node.right.value
          : undefined;
      if (values === undefined || values.length === 0) return undefined;
      const declared = typeOf(node.left);
      const membership: FlowFormula = {
        op: "in",
        value: left,
        options: values.map((value) => ({
          op: "literal",
          type: literalTypeFor(declared, value),
          value,
        })),
      };
      return node.operator === "in" ? membership : { op: "not", arg: membership };
    }
    const right = operand(node.right, node.left);
    if (right === undefined) return undefined;
    if (node.operator === "not_contains")
      return { op: "not", arg: { op: "contains", left, right } };
    const op = Object.entries(operators).find(([, value]) => value === node.operator)?.[0];
    return op === undefined ? undefined : ({ op, left, right } as FlowFormula);
  };
  return formula(condition);
};
