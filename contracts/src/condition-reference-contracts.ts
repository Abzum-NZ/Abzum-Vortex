import { z } from "zod";
import { sharingParameterValueTypeV2Schema } from "./catalogues";
import {
  boundedRuleGraphConditionInputSchema,
  ruleGraphBinaryConditionOperatorSchema,
  ruleGraphInputDeclarationSchema,
  ruleGraphTypedValueSchema,
  ruleGraphUnaryConditionOperatorSchema,
  ruleGraphVariableDeclarationSchema,
} from "./rule-graph-contracts";
import {
  conditionMaximumNestingDepth,
  conditionMaximumOperandCount,
  jsonValueSchema,
} from "./common";
import { builderKeySchema, containedComponentIdSchema, fieldIdSchema } from "./identifiers";
import { moduleFieldV3Schema } from "./module-contracts-v3";

const conditionReferenceOperandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("module_field"), fieldId: fieldIdSchema }).strict(),
  z
    .object({ kind: z.literal("module_parameter"), key: builderKeySchema })
    .strict(),
  z.object({ kind: z.literal("module_literal"), value: jsonValueSchema }).strict(),
  z.object({ kind: z.literal("graph_current_field"), fieldId: fieldIdSchema }).strict(),
  z.object({ kind: z.literal("graph_previous_field"), fieldId: fieldIdSchema }).strict(),
  z
    .object({ kind: z.literal("graph_input"), inputId: containedComponentIdSchema })
    .strict(),
  z
    .object({ kind: z.literal("graph_variable"), variableId: containedComponentIdSchema })
    .strict(),
  z.object({ kind: z.literal("graph_literal"), value: ruleGraphTypedValueSchema }).strict(),
]);

const conditionReferenceComparisonSchema = z.union([
  z
    .object({
      kind: z.literal("comparison"),
      operator: ruleGraphBinaryConditionOperatorSchema,
      left: conditionReferenceOperandSchema,
      right: conditionReferenceOperandSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("comparison"),
      operator: ruleGraphUnaryConditionOperatorSchema,
      left: conditionReferenceOperandSchema,
    })
    .strict(),
]);

export type ConditionReferenceNode =
  | z.infer<typeof conditionReferenceComparisonSchema>
  | { kind: "all" | "any"; conditions: ConditionReferenceNode[] }
  | { kind: "not"; condition: ConditionReferenceNode };

const conditionReferenceNodeSchema: z.ZodType<ConditionReferenceNode> = z.lazy(() =>
  z.union([
    conditionReferenceComparisonSchema,
    z
      .object({
        kind: z.literal("all"),
        conditions: z.array(conditionReferenceNodeSchema).min(1).max(50),
      })
      .strict(),
    z
      .object({
        kind: z.literal("any"),
        conditions: z.array(conditionReferenceNodeSchema).min(1).max(50),
      })
      .strict(),
    z.object({ kind: z.literal("not"), condition: conditionReferenceNodeSchema }).strict(),
  ]),
);

const moduleParameterDeclarationSchema = z
  .object({ key: builderKeySchema, type: sharingParameterValueTypeV2Schema })
  .strict();

const reportDuplicate = (
  values: readonly string[],
  path: string,
  context: z.RefinementCtx,
  message: string,
): void => {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) context.addIssue({ code: "custom", path: [path, index], message });
    seen.add(value);
  }
};

const moduleConditionReferenceDeclarationsSchema = z
  .object({
    fields: z.array(moduleFieldV3Schema).max(500),
    parameters: z.array(moduleParameterDeclarationSchema),
  })
  .strict()
  .superRefine((declarations, context) => {
    reportDuplicate(
      declarations.fields.map((field) => field.fieldId.toLowerCase()),
      "fields",
      context,
      "Module field identities must be unique",
    );
    reportDuplicate(
      declarations.fields.map((field) => field.key),
      "fields",
      context,
      "Module field catalogue keys must be unique",
    );
    reportDuplicate(
      declarations.parameters.map((parameter) => parameter.key),
      "parameters",
      context,
      "Module parameter catalogue keys must be unique",
    );
  });

const ruleGraphConditionReferenceDeclarationsSchema = z
  .object({
    fields: z.array(moduleFieldV3Schema).max(500),
    inputs: z.array(ruleGraphInputDeclarationSchema).max(100),
    variables: z.array(ruleGraphVariableDeclarationSchema).max(100),
  })
  .strict()
  .superRefine((declarations, context) => {
    reportDuplicate(
      declarations.fields.map((field) => field.fieldId.toLowerCase()),
      "fields",
      context,
      "Rule graph field identities must be unique",
    );
    reportDuplicate(
      declarations.fields.map((field) => field.key),
      "fields",
      context,
      "Rule graph field catalogue keys must be unique",
    );
    reportDuplicate(
      declarations.inputs.map((input) => input.inputId.toLowerCase()),
      "inputs",
      context,
      "Rule graph input identities must be unique",
    );
    reportDuplicate(
      declarations.inputs.map((input) => input.key),
      "inputs",
      context,
      "Rule graph input catalogue keys must be unique",
    );
    reportDuplicate(
      declarations.variables.map((variable) => variable.variableId.toLowerCase()),
      "variables",
      context,
      "Rule graph variable identities must be unique",
    );
    reportDuplicate(
      declarations.variables.map((variable) => variable.key),
      "variables",
      context,
      "Rule graph variable catalogue keys must be unique",
    );
  });

export type ModuleConditionReferenceDeclarations = z.infer<
  typeof moduleConditionReferenceDeclarationsSchema
>;
export type RuleGraphConditionReferenceDeclarations = z.infer<
  typeof ruleGraphConditionReferenceDeclarationsSchema
>;
export type ConditionReferenceOperand = z.infer<typeof conditionReferenceOperandSchema>;

const conditionReferenceContractBaseSchema = z.discriminatedUnion("sourceProfile", [
  z
    .object({
      sourceProfile: z.literal("module"),
      condition: conditionReferenceNodeSchema,
      declarations: moduleConditionReferenceDeclarationsSchema,
    })
    .strict(),
  z
    .object({
      sourceProfile: z.literal("rule_graph"),
      condition: conditionReferenceNodeSchema,
      declarations: ruleGraphConditionReferenceDeclarationsSchema,
    })
    .strict(),
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const boundedConditionReferenceInputSchema = z.unknown().superRefine((input, context) => {
  const rawCondition = isRecord(input) ? input.condition : undefined;
  const bounded = boundedRuleGraphConditionInputSchema.safeParse(rawCondition);
  if (!bounded.success)
    for (const issue of bounded.error.issues)
      context.addIssue({
        code: "custom",
        path: ["condition", ...issue.path],
        message: issue.message,
      });
});

const operandsIn = (
  condition: ConditionReferenceNode,
  path: (string | number)[] = ["condition"],
): { operand: ConditionReferenceOperand; path: (string | number)[] }[] => {
  const pending: { node: ConditionReferenceNode; path: (string | number)[] }[] = [
    { node: condition, path },
  ];
  const found: { operand: ConditionReferenceOperand; path: (string | number)[] }[] = [];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.node.kind === "comparison") {
      found.push({ operand: current.node.left, path: [...current.path, "left"] });
      if ("right" in current.node)
        found.push({ operand: current.node.right, path: [...current.path, "right"] });
    } else if (current.node.kind === "not") {
      pending.push({ node: current.node.condition, path: [...current.path, "condition"] });
    } else {
      for (let index = current.node.conditions.length - 1; index >= 0; index -= 1)
        pending.push({
          node: current.node.conditions[index]!,
          path: [...current.path, "conditions", index],
        });
    }
  }
  return found;
};

/**
 * A strict structural view of one parsed Module ConditionNode or executable RuleGraphCondition.
 * It preserves exact declaration context and uses it only to validate reference identity. It does
 * not carry authority, release admission, runtime values or evaluator behavior.
 */
export const conditionReferenceContractSchema = boundedConditionReferenceInputSchema
  .pipe(conditionReferenceContractBaseSchema)
  .superRefine((contract, context) => {
    const module = contract.sourceProfile === "module";
    // UUID comparison keys follow platform identity semantics without rewriting authored evidence.
    const fieldIds = new Set(
      contract.declarations.fields.map((field) => field.fieldId.toLowerCase()),
    );
    const moduleParameterKeys = module
      ? new Set(contract.declarations.parameters.map((parameter) => parameter.key))
      : new Set<string>();
    const graphInputIds = module
      ? new Set<string>()
      : new Set(contract.declarations.inputs.map((input) => input.inputId.toLowerCase()));
    const graphVariableIds = module
      ? new Set<string>()
      : new Set(contract.declarations.variables.map((variable) => variable.variableId.toLowerCase()));

    const operands = operandsIn(contract.condition);
    for (const { operand, path } of operands) {
      if (module) {
        if (operand.kind.startsWith("graph_")) {
          context.addIssue({
            code: "custom",
            path,
            message: "A rule-graph operand is incompatible with the Module source profile",
          });
          continue;
        }
        if (operand.kind === "module_field" && !fieldIds.has(operand.fieldId.toLowerCase()))
          context.addIssue({ code: "custom", path, message: "Module field reference is unbound" });
        if (operand.kind === "module_parameter" && !moduleParameterKeys.has(operand.key))
          context.addIssue({
            code: "custom",
            path,
            message: "Module parameter reference is unbound",
          });
      } else {
        if (operand.kind.startsWith("module_")) {
          context.addIssue({
            code: "custom",
            path,
            message: "A Module operand is incompatible with the rule-graph source profile",
          });
          continue;
        }
        if (
          (operand.kind === "graph_current_field" || operand.kind === "graph_previous_field") &&
          !fieldIds.has(operand.fieldId.toLowerCase())
        )
          context.addIssue({ code: "custom", path, message: "Rule graph field reference is unbound" });
        if (operand.kind === "graph_input" && !graphInputIds.has(operand.inputId.toLowerCase()))
          context.addIssue({ code: "custom", path, message: "Rule graph input reference is unbound" });
        if (operand.kind === "graph_variable" && !graphVariableIds.has(operand.variableId.toLowerCase()))
          context.addIssue({
            code: "custom",
            path,
            message: "Rule graph variable reference is unbound",
          });
      }
    }

    if (operands.length > conditionMaximumOperandCount)
      context.addIssue({
        code: "custom",
        path: ["condition"],
        message: `Condition operands cannot exceed ${conditionMaximumOperandCount}`,
      });

    const inspectDepth = (node: ConditionReferenceNode, depth: number): number => {
      if (node.kind === "comparison") return depth;
      if (node.kind === "not") return inspectDepth(node.condition, depth + 1);
      return Math.max(depth, ...node.conditions.map((child) => inspectDepth(child, depth + 1)));
    };
    if (inspectDepth(contract.condition, 1) > conditionMaximumNestingDepth)
      context.addIssue({
        code: "custom",
        path: ["condition"],
        message: `Condition nesting cannot exceed ${conditionMaximumNestingDepth} levels`,
      });
  });

export type ConditionReferenceContract = z.infer<typeof conditionReferenceContractSchema>;
