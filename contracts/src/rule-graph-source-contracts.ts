import { z } from "zod";
import { sourceAliasSchema, sourceQualifiedRecordTypeSchema } from "./definition-source-common";
import { builderKeySchema } from "./identifiers";
import { sourceModuleFieldValueV2Schemas } from "./module-field-values-v2";
import {
  ruleGraphBinaryConditionOperatorSchema,
  boundedRuleGraphConditionInputSchema,
  ruleGraphContractVersion,
  ruleGraphNodeContractVersion,
  ruleGraphUnaryConditionOperatorSchema,
  ruleGraphValueTypeKeys,
  ruleGraphValueTypeSchema,
  type RuleGraphValueType,
} from "./rule-graph-contracts";

const sourceTypedValueBranches = ruleGraphValueTypeKeys.map((type) =>
  z
    .object({
      type: z.literal(type),
      value: sourceModuleFieldValueV2Schemas[type],
    })
    .strict(),
);

export const sourceRuleGraphTypedValueSchema = z.discriminatedUnion(
  "type",
  sourceTypedValueBranches as unknown as readonly [
    (typeof sourceTypedValueBranches)[number],
    (typeof sourceTypedValueBranches)[number],
    ...(typeof sourceTypedValueBranches)[number][],
  ],
);
export type SourceRuleGraphTypedValue = z.infer<typeof sourceRuleGraphTypedValueSchema>;

const referenceValueTypes = new Set<RuleGraphValueType>(["link", "link_to_one_of_several"]);
const validateReferenceTargets = (
  value: { type: RuleGraphValueType; record_types?: readonly string[] | undefined },
  context: z.RefinementCtx,
) => {
  const isRecordReference = referenceValueTypes.has(value.type);
  if (isRecordReference !== (value.record_types !== undefined))
    context.addIssue({
      code: "custom",
      path: ["record_types"],
      message: isRecordReference
        ? "A record-reference value type requires allowed record types"
        : "Only a record-reference value type may declare allowed record types",
    });
  if (
    value.record_types !== undefined &&
    new Set(value.record_types).size !== value.record_types.length
  )
    context.addIssue({
      code: "custom",
      path: ["record_types"],
      message: "Allowed record types must be unique",
    });
};

export const sourceRuleGraphInputDeclarationSchema = z
  .object({
    id: sourceAliasSchema,
    key: builderKeySchema,
    type: ruleGraphValueTypeSchema,
    required: z.boolean(),
    record_types: z.array(sourceQualifiedRecordTypeSchema).min(1).max(20).optional(),
  })
  .strict()
  .superRefine(validateReferenceTargets);
export type SourceRuleGraphInputDeclaration = z.infer<typeof sourceRuleGraphInputDeclarationSchema>;

export const sourceRuleGraphVariableDeclarationSchema = z
  .object({
    id: sourceAliasSchema,
    key: builderKeySchema,
    type: ruleGraphValueTypeSchema,
    record_types: z.array(sourceQualifiedRecordTypeSchema).min(1).max(20).optional(),
    default_value: sourceRuleGraphTypedValueSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    validateReferenceTargets(value, context);
    if (value.default_value !== undefined && value.default_value.type !== value.type)
      context.addIssue({
        code: "custom",
        path: ["default_value", "type"],
        message: "A variable default must match its declared type",
      });
  });
export type SourceRuleGraphVariableDeclaration = z.infer<
  typeof sourceRuleGraphVariableDeclarationSchema
>;

export const sourceRuleGraphOperandSchema = z.union([
  z.object({ source: z.literal("literal"), value: sourceRuleGraphTypedValueSchema }).strict(),
  z.object({ source: z.literal("input"), input: sourceAliasSchema }).strict(),
  z.object({ source: z.literal("variable"), variable: sourceAliasSchema }).strict(),
  z.object({ source: z.literal("current_field"), field: sourceAliasSchema }).strict(),
  z.object({ source: z.literal("previous_field"), field: sourceAliasSchema }).strict(),
]);
export type SourceRuleGraphOperand = z.infer<typeof sourceRuleGraphOperandSchema>;

const sourceRuleGraphComparisonConditionSchema = z.union([
  z
    .object({
      kind: z.literal("comparison"),
      operator: ruleGraphBinaryConditionOperatorSchema,
      left: sourceRuleGraphOperandSchema,
      right: sourceRuleGraphOperandSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("comparison"),
      operator: ruleGraphUnaryConditionOperatorSchema,
      left: sourceRuleGraphOperandSchema,
    })
    .strict(),
]);

export type SourceRuleGraphCondition =
  | z.infer<typeof sourceRuleGraphComparisonConditionSchema>
  | { kind: "all" | "any"; conditions: SourceRuleGraphCondition[] }
  | { kind: "not"; condition: SourceRuleGraphCondition };

const sourceRuleGraphConditionTreeSchema: z.ZodType<SourceRuleGraphCondition> = z.lazy(() =>
  z.union([
    sourceRuleGraphComparisonConditionSchema,
    z
      .object({
        kind: z.literal("all"),
        conditions: z.array(sourceRuleGraphConditionTreeSchema).min(1).max(50),
      })
      .strict(),
    z
      .object({
        kind: z.literal("any"),
        conditions: z.array(sourceRuleGraphConditionTreeSchema).min(1).max(50),
      })
      .strict(),
    z.object({ kind: z.literal("not"), condition: sourceRuleGraphConditionTreeSchema }).strict(),
  ]),
);

export const sourceRuleGraphConditionSchema = boundedRuleGraphConditionInputSchema.pipe(
  sourceRuleGraphConditionTreeSchema,
);

const safeRuleCodeSchema = builderKeySchema;
const safeRuleMessageSchema = z
  .string()
  .min(1)
  .max(300)
  .refine((message) => message.trim().length > 0, "A safe message cannot be blank");

const sourceNodeBase = {
  id: sourceAliasSchema,
  node_version: z.literal(ruleGraphNodeContractVersion),
};

const sourceRuleGraphStartNodeSchema = z
  .object({
    ...sourceNodeBase,
    type: z.literal("start"),
    operations: z
      .array(z.enum(["create", "update"]))
      .min(1)
      .max(2),
  })
  .strict()
  .refine((value) => new Set(value.operations).size === value.operations.length, {
    path: ["operations"],
    message: "Start operations must be unique",
  });

const sourceRuleGraphConditionNodeSchema = z
  .object({
    ...sourceNodeBase,
    type: z.literal("condition"),
    condition: sourceRuleGraphConditionSchema,
  })
  .strict();

const sourceRuleGraphSetVariableNodeSchema = z
  .object({
    ...sourceNodeBase,
    type: z.literal("set_variable"),
    variable: sourceAliasSchema,
    value: sourceRuleGraphOperandSchema,
  })
  .strict();

export const sourceRuleGraphFieldAssignmentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set"), value: sourceRuleGraphOperandSchema }).strict(),
  z.object({ kind: z.literal("clear") }).strict(),
]);

const sourceRuleGraphSetFieldNodeSchema = z
  .object({
    ...sourceNodeBase,
    type: z.literal("set_field"),
    field: sourceAliasSchema,
    assignment: sourceRuleGraphFieldAssignmentSchema,
  })
  .strict();

const sourceRuleGraphRequireFieldNodeSchema = z
  .object({
    ...sourceNodeBase,
    type: z.literal("require_field"),
    field: sourceAliasSchema,
    code: safeRuleCodeSchema,
    message: safeRuleMessageSchema,
  })
  .strict();

const sourceRuleGraphWarnNodeSchema = z
  .object({
    ...sourceNodeBase,
    type: z.literal("warn"),
    code: safeRuleCodeSchema,
    message: safeRuleMessageSchema,
  })
  .strict();

const sourceRuleGraphRefuseNodeSchema = z
  .object({
    ...sourceNodeBase,
    type: z.literal("refuse"),
    code: safeRuleCodeSchema,
    message: safeRuleMessageSchema,
    field: sourceAliasSchema.optional(),
  })
  .strict();

const sourceRuleGraphFinishNodeSchema = z
  .object({
    ...sourceNodeBase,
    type: z.literal("finish"),
  })
  .strict();

export const sourceRuleGraphNodeSchema = z.union([
  sourceRuleGraphStartNodeSchema,
  sourceRuleGraphConditionNodeSchema,
  sourceRuleGraphSetVariableNodeSchema,
  sourceRuleGraphSetFieldNodeSchema,
  sourceRuleGraphRequireFieldNodeSchema,
  sourceRuleGraphWarnNodeSchema,
  sourceRuleGraphRefuseNodeSchema,
  sourceRuleGraphFinishNodeSchema,
]);
export type SourceRuleGraphNode = z.infer<typeof sourceRuleGraphNodeSchema>;

export const sourceRuleGraphEdgeSchema = z
  .object({
    from: sourceAliasSchema,
    port: z.enum(["next", "true", "false"]),
    to: sourceAliasSchema,
  })
  .strict();
export type SourceRuleGraphEdge = z.infer<typeof sourceRuleGraphEdgeSchema>;

const reportDuplicate = (
  values: readonly string[],
  path: string,
  context: z.RefinementCtx,
  message: string,
) => {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) context.addIssue({ code: "custom", path: [path, index], message });
    seen.add(value);
  }
};

export const sourceRuleGraphSchema = z
  .object({
    id: sourceAliasSchema,
    key: builderKeySchema,
    record_type: sourceAliasSchema,
    profile: z.literal("before_save"),
    graph_version: z.literal(ruleGraphContractVersion),
    priority: z.number().int().min(0).max(10_000),
    inputs: z.array(sourceRuleGraphInputDeclarationSchema).max(100),
    variables: z.array(sourceRuleGraphVariableDeclarationSchema).max(100),
    nodes: z.array(sourceRuleGraphNodeSchema).min(1).max(100),
    edges: z.array(sourceRuleGraphEdgeSchema).max(200),
  })
  .strict()
  .superRefine((value, context) => {
    reportDuplicate(
      value.inputs.map((input) => input.id),
      "inputs",
      context,
      "Rule input aliases must be unique",
    );
    reportDuplicate(
      value.inputs.map((input) => input.key),
      "inputs",
      context,
      "Rule input keys must be unique",
    );
    reportDuplicate(
      value.variables.map((variable) => variable.id),
      "variables",
      context,
      "Rule variable aliases must be unique",
    );
    reportDuplicate(
      value.variables.map((variable) => variable.key),
      "variables",
      context,
      "Rule variable keys must be unique",
    );
    reportDuplicate(
      value.nodes.map((node) => node.id),
      "nodes",
      context,
      "Rule node aliases must be unique",
    );
    reportDuplicate(
      value.edges.map((edge) => `${edge.from}:${edge.port}`),
      "edges",
      context,
      "A rule node port may have only one outgoing edge",
    );
  });
export type SourceRuleGraph = z.infer<typeof sourceRuleGraphSchema>;
