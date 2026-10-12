import { z } from "zod";
import {
  type ConditionReferenceContract,
  type ConditionReferenceNode,
  type ConditionReferenceOperand,
  type ModuleConditionReferenceDeclarations,
  type RuleGraphConditionReferenceDeclarations,
  conditionReferenceContractSchema,
} from "./condition-reference-contracts";
import {
  boundedRuleGraphConditionInputSchema,
  ruleGraphConditionSchema,
} from "./rule-graph-contracts";
import type { RuleGraphCondition } from "./rule-graph-contracts";
import { conditionNodeSchema } from "./module-contracts";
import type { ConditionNode } from "./module-contracts";

type ModuleComparison = Extract<ConditionNode, { kind: "comparison" }>;
type ModuleOperand = ModuleComparison["left"];
type RuleGraphComparison = Extract<RuleGraphCondition, { kind: "comparison" }>;
type RuleGraphOperand = RuleGraphComparison["left"];
type ModuleReferenceContract = Extract<ConditionReferenceContract, { sourceProfile: "module" }>;
type RuleGraphReferenceContract = Extract<
  ConditionReferenceContract,
  { sourceProfile: "rule_graph" }
>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertModuleUnaryRightAbsent = (input: unknown): void => {
  const pending: { value: unknown; path: (string | number)[] }[] = [
    { value: input, path: ["condition"] },
  ];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (!isRecord(current.value)) continue;
    if (current.value.kind === "comparison") {
      if (
        (current.value.operator === "is_empty" || current.value.operator === "is_not_empty") &&
        Object.prototype.hasOwnProperty.call(current.value, "right")
      )
        throw new z.ZodError([
          {
            code: "custom",
            path: [...current.path, "right"],
            message: "A unary Module condition must omit the right operand",
          },
        ]);
      continue;
    }
    if (current.value.kind === "not") {
      pending.push({ value: current.value.condition, path: [...current.path, "condition"] });
      continue;
    }
    if (
      (current.value.kind === "all" || current.value.kind === "any") &&
      Array.isArray(current.value.conditions)
    )
      for (let index = current.value.conditions.length - 1; index >= 0; index -= 1)
        pending.push({
          value: current.value.conditions[index],
          path: [...current.path, "conditions", index],
        });
  }
};

const toModuleReferenceOperand = (operand: ModuleOperand): ConditionReferenceOperand => {
  switch (operand.source) {
    case "field":
      return { kind: "module_field", fieldId: operand.fieldId };
    case "parameter":
      return { kind: "module_parameter", key: operand.key };
    case "value":
      return { kind: "module_literal", value: operand.value };
  }
};

const toRuleGraphReferenceOperand = (operand: RuleGraphOperand): ConditionReferenceOperand => {
  switch (operand.source) {
    case "literal":
      return { kind: "graph_literal", value: operand.value };
    case "input":
      return { kind: "graph_input", inputId: operand.inputId };
    case "variable":
      return { kind: "graph_variable", variableId: operand.variableId };
    case "current_field":
      return { kind: "graph_current_field", fieldId: operand.fieldId };
    case "previous_field":
      return { kind: "graph_previous_field", fieldId: operand.fieldId };
  }
};

const toModuleReferenceNode = (node: ConditionNode): ConditionReferenceNode => {
  if (node.kind === "comparison") {
    const left = toModuleReferenceOperand(node.left);
    if (node.operator === "is_empty" || node.operator === "is_not_empty")
      return { kind: "comparison", operator: node.operator, left };
    if (node.right === undefined)
      throw new TypeError("A binary Module condition must contain its right operand");
    return {
      kind: "comparison",
      operator: node.operator,
      left,
      right: toModuleReferenceOperand(node.right),
    };
  }
  if (node.kind === "not")
    return { kind: "not", condition: toModuleReferenceNode(node.condition) };
  return { kind: node.kind, conditions: node.conditions.map(toModuleReferenceNode) };
};

const toRuleGraphReferenceNode = (node: RuleGraphCondition): ConditionReferenceNode => {
  if (node.kind === "comparison") {
    const left = toRuleGraphReferenceOperand(node.left);
    if ("right" in node)
      return {
        kind: "comparison",
        operator: node.operator,
        left,
        right: toRuleGraphReferenceOperand(node.right),
      };
    return { kind: "comparison", operator: node.operator, left };
  }
  if (node.kind === "not")
    return { kind: "not", condition: toRuleGraphReferenceNode(node.condition) };
  return { kind: node.kind, conditions: node.conditions.map(toRuleGraphReferenceNode) };
};

/** Project a strict Module ConditionNode into its structural reference representation. */
export const projectModuleConditionToReferences = (
  condition: unknown,
  declarations: ModuleConditionReferenceDeclarations,
): ModuleReferenceContract => {
  boundedRuleGraphConditionInputSchema.parse(condition);
  const parsedCondition = conditionNodeSchema.parse(condition);
  assertModuleUnaryRightAbsent(condition);
  const contract = conditionReferenceContractSchema.parse({
    sourceProfile: "module",
    condition: toModuleReferenceNode(parsedCondition),
    declarations,
  });
  if (contract.sourceProfile !== "module")
    throw new TypeError("A Module projection requires its Module source profile");
  return contract;
};

/** Project a strict executable RuleGraphCondition into its structural reference representation. */
export const projectRuleGraphConditionToReferences = (
  condition: unknown,
  declarations: RuleGraphConditionReferenceDeclarations,
): RuleGraphReferenceContract => {
  const parsedCondition = ruleGraphConditionSchema.parse(condition);
  const contract = conditionReferenceContractSchema.parse({
    sourceProfile: "rule_graph",
    condition: toRuleGraphReferenceNode(parsedCondition),
    declarations,
  });
  if (contract.sourceProfile !== "rule_graph")
    throw new TypeError("A rule-graph projection requires its rule-graph source profile");
  return contract;
};

const fromModuleReferenceOperand = (operand: ConditionReferenceOperand): ModuleOperand => {
  switch (operand.kind) {
    case "module_field":
      return { source: "field", fieldId: operand.fieldId };
    case "module_parameter":
      return { source: "parameter", key: operand.key };
    case "module_literal":
      return { source: "value", value: operand.value };
    default:
      throw new TypeError("A rule-graph operand cannot be projected as a Module operand");
  }
};

const fromRuleGraphReferenceOperand = (operand: ConditionReferenceOperand): RuleGraphOperand => {
  switch (operand.kind) {
    case "graph_literal":
      return { source: "literal", value: operand.value };
    case "graph_input":
      return { source: "input", inputId: operand.inputId };
    case "graph_variable":
      return { source: "variable", variableId: operand.variableId };
    case "graph_current_field":
      return { source: "current_field", fieldId: operand.fieldId };
    case "graph_previous_field":
      return { source: "previous_field", fieldId: operand.fieldId };
    default:
      throw new TypeError("A Module operand cannot be projected as a rule-graph operand");
  }
};

const fromModuleReferenceNode = (node: ConditionReferenceNode): ConditionNode => {
  if (node.kind === "comparison") {
    const left = fromModuleReferenceOperand(node.left);
    if ("right" in node)
      return {
        kind: "comparison",
        operator: node.operator,
        left,
        right: fromModuleReferenceOperand(node.right),
      };
    return { kind: "comparison", operator: node.operator, left };
  }
  if (node.kind === "not")
    return { kind: "not", condition: fromModuleReferenceNode(node.condition) };
  return { kind: node.kind, conditions: node.conditions.map(fromModuleReferenceNode) };
};

const fromRuleGraphReferenceNode = (node: ConditionReferenceNode): RuleGraphCondition => {
  if (node.kind === "comparison") {
    const left = fromRuleGraphReferenceOperand(node.left);
    if ("right" in node)
      return {
        kind: "comparison",
        operator: node.operator,
        left,
        right: fromRuleGraphReferenceOperand(node.right),
      };
    return { kind: "comparison", operator: node.operator, left };
  }
  if (node.kind === "not")
    return { kind: "not", condition: fromRuleGraphReferenceNode(node.condition) };
  return { kind: node.kind, conditions: node.conditions.map(fromRuleGraphReferenceNode) };
};

/** Invert only a Module-profile representation; declaration context is revalidated, not rebound. */
export const projectReferencesToModuleCondition = (contract: unknown): ConditionNode => {
  const parsedContract = conditionReferenceContractSchema.parse(contract);
  if (parsedContract.sourceProfile !== "module")
    throw new TypeError("A rule-graph reference contract cannot be projected to a Module condition");
  const condition = fromModuleReferenceNode(parsedContract.condition);
  boundedRuleGraphConditionInputSchema.parse(condition);
  assertModuleUnaryRightAbsent(condition);
  return conditionNodeSchema.parse(condition);
};

/** Invert only a rule-graph-profile representation; declaration context is revalidated, not rebound. */
export const projectReferencesToRuleGraphCondition = (
  contract: unknown,
): RuleGraphCondition => {
  const parsedContract = conditionReferenceContractSchema.parse(contract);
  if (parsedContract.sourceProfile !== "rule_graph")
    throw new TypeError("A Module reference contract cannot be projected to a rule-graph condition");
  return ruleGraphConditionSchema.parse(fromRuleGraphReferenceNode(parsedContract.condition));
};
