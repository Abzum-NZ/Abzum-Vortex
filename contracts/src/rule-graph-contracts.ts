import { z } from "zod";
import { conditionMaximumNestingDepth, conditionMaximumOperandCount } from "./common";
import {
  builderKeySchema,
  containedComponentIdSchema,
  fieldIdSchema,
  recordTypeIdSchema,
  ruleIdSchema,
} from "./identifiers";
import { moduleFieldValueV2Schemas } from "./module-field-values-v2";
import {
  maximumRuleTableRows,
  ruleTableColumnsMatch,
  ruleTableColumnsSchema,
  validateRuleTableDeclaration,
  validateRuleTableRows,
} from "./rule-table-values";
export {
  ruleTableColumnSchema,
  ruleTableColumnsSchema,
  sourceRuleTableColumnsSchema,
} from "./rule-table-values";
export type { RuleTableColumn } from "./rule-table-values";

export const ruleGraphContractVersion = "1.0.0" as const;
export const ruleGraphNodeContractVersion = "1.0.0" as const;

export const ruleGraphValueTypeKeys = [
  "text",
  "long_text",
  "formatted_text",
  "whole_number",
  "decimal_number",
  "money",
  "yes_no",
  "date",
  "date_time",
  "choice",
  "several_choices",
  "email_address",
  "phone_number",
  "web_address",
  "table",
  "link",
  "link_to_one_of_several",
  "link_to_person",
  "attachment",
] as const;

export const ruleGraphValueTypeSchema = z.enum(ruleGraphValueTypeKeys);
export type RuleGraphValueType = z.infer<typeof ruleGraphValueTypeSchema>;

const typedValueBranches = ruleGraphValueTypeKeys.map((type) =>
  z
    .object({
      type: z.literal(type),
      value:
        type === "table"
          ? moduleFieldValueV2Schemas.table.max(maximumRuleTableRows)
          : moduleFieldValueV2Schemas[type],
      columns: type === "table" ? ruleTableColumnsSchema : z.never().optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.type === "table" && value.columns !== undefined)
        validateRuleTableRows(
          value.columns,
          value.value as Record<string, unknown>[],
          context,
          false,
        );
    }),
);

export const ruleGraphTypedValueSchema = z.discriminatedUnion(
  "type",
  typedValueBranches as unknown as readonly [
    (typeof typedValueBranches)[number],
    (typeof typedValueBranches)[number],
    ...(typeof typedValueBranches)[number][],
  ],
);
export type RuleGraphTypedValue = z.infer<typeof ruleGraphTypedValueSchema>;

const referenceValueTypes = new Set<RuleGraphValueType>(["link", "link_to_one_of_several"]);
const validateReferenceTargets = (
  value: { type: RuleGraphValueType; recordTypeIds?: readonly string[] | undefined },
  context: z.RefinementCtx,
) => {
  const isRecordReference = referenceValueTypes.has(value.type);
  if (isRecordReference !== (value.recordTypeIds !== undefined))
    context.addIssue({
      code: "custom",
      path: ["recordTypeIds"],
      message: isRecordReference
        ? "A record-reference value type requires allowed record types"
        : "Only a record-reference value type may declare allowed record types",
    });
  if (
    value.recordTypeIds !== undefined &&
    new Set(value.recordTypeIds).size !== value.recordTypeIds.length
  )
    context.addIssue({
      code: "custom",
      path: ["recordTypeIds"],
      message: "Allowed record-type identities must be unique",
    });
  if (
    value.recordTypeIds?.some(
      (recordTypeId, index) => index > 0 && value.recordTypeIds![index - 1]! >= recordTypeId,
    )
  )
    context.addIssue({
      code: "custom",
      path: ["recordTypeIds"],
      message: "Allowed record-type identities must use canonical order",
    });
};

const ruleGraphInputDeclarationBaseSchema = z
  .object({
    inputId: containedComponentIdSchema,
    key: builderKeySchema,
    type: ruleGraphValueTypeSchema,
    required: z.boolean(),
    recordTypeIds: z.array(recordTypeIdSchema).min(1).max(20).optional(),
    columns: ruleTableColumnsSchema.optional(),
  })
  .strict();

export const ruleGraphInputDeclarationSchema = ruleGraphInputDeclarationBaseSchema
  .superRefine(validateReferenceTargets)
  .superRefine(validateRuleTableDeclaration);
export type RuleGraphInputDeclaration = z.infer<typeof ruleGraphInputDeclarationSchema>;

export const ruleGraphVariableDeclarationSchema = z
  .object({
    variableId: containedComponentIdSchema,
    key: builderKeySchema,
    type: ruleGraphValueTypeSchema,
    recordTypeIds: z.array(recordTypeIdSchema).min(1).max(20).optional(),
    defaultValue: ruleGraphTypedValueSchema.optional(),
    columns: ruleTableColumnsSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    validateReferenceTargets(value, context);
    validateRuleTableDeclaration(value, context);
    if (
      value.type === "table" &&
      value.columns &&
      value.defaultValue?.columns &&
      !ruleTableColumnsMatch(value.columns, value.defaultValue.columns)
    )
      context.addIssue({
        code: "custom",
        path: ["defaultValue", "columns"],
        message: "Table default columns must match the variable declaration",
      });
    if (value.defaultValue !== undefined && value.defaultValue.type !== value.type)
      context.addIssue({
        code: "custom",
        path: ["defaultValue", "type"],
        message: "A variable default must match its declared type",
      });
  });
export type RuleGraphVariableDeclaration = z.infer<typeof ruleGraphVariableDeclarationSchema>;

export const ruleGraphOperandSchema = z.union([
  z.object({ source: z.literal("literal"), value: ruleGraphTypedValueSchema }).strict(),
  z.object({ source: z.literal("input"), inputId: containedComponentIdSchema }).strict(),
  z.object({ source: z.literal("variable"), variableId: containedComponentIdSchema }).strict(),
  z.object({ source: z.literal("current_field"), fieldId: fieldIdSchema }).strict(),
  z.object({ source: z.literal("previous_field"), fieldId: fieldIdSchema }).strict(),
]);
export type RuleGraphOperand = z.infer<typeof ruleGraphOperandSchema>;

export const ruleGraphBinaryConditionOperatorSchema = z.enum([
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "in",
  "not_in",
  "greater_than",
  "greater_than_or_equal",
  "less_than",
  "less_than_or_equal",
]);
export const ruleGraphUnaryConditionOperatorSchema = z.enum(["is_empty", "is_not_empty"]);

const ruleGraphComparisonConditionSchema = z.union([
  z
    .object({
      kind: z.literal("comparison"),
      operator: ruleGraphBinaryConditionOperatorSchema,
      left: ruleGraphOperandSchema,
      right: ruleGraphOperandSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("comparison"),
      operator: ruleGraphUnaryConditionOperatorSchema,
      left: ruleGraphOperandSchema,
    })
    .strict(),
]);

export type RuleGraphCondition =
  | z.infer<typeof ruleGraphComparisonConditionSchema>
  | { kind: "all" | "any"; conditions: RuleGraphCondition[] }
  | { kind: "not"; condition: RuleGraphCondition };

const ruleGraphConditionTreeSchema: z.ZodType<RuleGraphCondition> = z.lazy(() =>
  z.union([
    ruleGraphComparisonConditionSchema,
    z
      .object({
        kind: z.literal("all"),
        conditions: z.array(ruleGraphConditionTreeSchema).min(1).max(50),
      })
      .strict(),
    z
      .object({
        kind: z.literal("any"),
        conditions: z.array(ruleGraphConditionTreeSchema).min(1).max(50),
      })
      .strict(),
    z.object({ kind: z.literal("not"), condition: ruleGraphConditionTreeSchema }).strict(),
  ]),
);

/** Refuses adversarially deep raw input before the recursive typed parser runs. */
export const boundedRuleGraphConditionInputSchema = z
  .unknown()
  .superRefine((condition, context) => {
    const pending: { value: unknown; depth: number }[] = [{ value: condition, depth: 1 }];
    let inspectedNodes = 0;
    let operands = 0;
    while (pending.length > 0) {
      const current = pending.pop()!;
      inspectedNodes += 1;
      if (
        current.depth > conditionMaximumNestingDepth ||
        inspectedNodes > conditionMaximumNestingDepth * conditionMaximumOperandCount
      ) {
        context.addIssue({ code: "custom", message: "Condition nesting is too deep" });
        return;
      }
      if (
        typeof current.value !== "object" ||
        current.value === null ||
        Array.isArray(current.value)
      )
        continue;
      const value = current.value as Record<string, unknown>;
      if (value.kind === "comparison") {
        operands += value.right === undefined ? 1 : 2;
        if (operands > conditionMaximumOperandCount) {
          context.addIssue({ code: "custom", message: "Condition uses too many operands" });
          return;
        }
        continue;
      }
      if (value.kind === "not") {
        pending.push({ value: value.condition, depth: current.depth + 1 });
        continue;
      }
      if ((value.kind === "all" || value.kind === "any") && Array.isArray(value.conditions)) {
        if (value.conditions.length > 50) {
          context.addIssue({ code: "custom", message: "A condition group is too large" });
          return;
        }
        for (const child of value.conditions)
          pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  });

export const ruleGraphConditionSchema = boundedRuleGraphConditionInputSchema.pipe(
  ruleGraphConditionTreeSchema,
);

const safeRuleCodeSchema = builderKeySchema;
const safeRuleMessageSchema = z
  .string()
  .min(1)
  .max(300)
  .refine((message) => message.trim().length > 0, "A safe message cannot be blank");

const canonicalNodeBase = {
  nodeId: containedComponentIdSchema,
  nodeVersion: z.literal(ruleGraphNodeContractVersion),
};

const ruleGraphStartNodeSchema = z
  .object({
    ...canonicalNodeBase,
    type: z.literal("start"),
    operations: z
      .array(z.enum(["create", "update"]))
      .min(1)
      .max(2),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.operations).size !== value.operations.length)
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: "Start operations must be unique",
      });
    if (
      value.operations.some(
        (operation, index) => index > 0 && value.operations[index - 1]! >= operation,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: "Start operations must use canonical order",
      });
  });

const ruleGraphConditionNodeSchema = z
  .object({
    ...canonicalNodeBase,
    type: z.literal("condition"),
    condition: ruleGraphConditionSchema,
  })
  .strict();

const ruleGraphSetVariableNodeSchema = z
  .object({
    ...canonicalNodeBase,
    type: z.literal("set_variable"),
    variableId: containedComponentIdSchema,
    value: ruleGraphOperandSchema,
  })
  .strict();

export const ruleGraphFieldAssignmentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set"), value: ruleGraphOperandSchema }).strict(),
  z.object({ kind: z.literal("clear") }).strict(),
]);

const ruleGraphSetFieldNodeSchema = z
  .object({
    ...canonicalNodeBase,
    type: z.literal("set_field"),
    fieldId: fieldIdSchema,
    assignment: ruleGraphFieldAssignmentSchema,
  })
  .strict();

const ruleGraphRequireFieldNodeSchema = z
  .object({
    ...canonicalNodeBase,
    type: z.literal("require_field"),
    fieldId: fieldIdSchema,
    code: safeRuleCodeSchema,
    message: safeRuleMessageSchema,
  })
  .strict();

const ruleGraphWarnNodeSchema = z
  .object({
    ...canonicalNodeBase,
    type: z.literal("warn"),
    code: safeRuleCodeSchema,
    message: safeRuleMessageSchema,
  })
  .strict();

const ruleGraphRefuseNodeSchema = z
  .object({
    ...canonicalNodeBase,
    type: z.literal("refuse"),
    code: safeRuleCodeSchema,
    message: safeRuleMessageSchema,
    fieldId: fieldIdSchema.optional(),
  })
  .strict();

const ruleGraphFinishNodeSchema = z
  .object({
    ...canonicalNodeBase,
    type: z.literal("finish"),
  })
  .strict();

export const ruleGraphNodeSchema = z.union([
  ruleGraphStartNodeSchema,
  ruleGraphConditionNodeSchema,
  ruleGraphSetVariableNodeSchema,
  ruleGraphSetFieldNodeSchema,
  ruleGraphRequireFieldNodeSchema,
  ruleGraphWarnNodeSchema,
  ruleGraphRefuseNodeSchema,
  ruleGraphFinishNodeSchema,
]);
export type RuleGraphNode = z.infer<typeof ruleGraphNodeSchema>;

export const ruleGraphPortSchema = z.enum(["next", "true", "false"]);
export const ruleGraphEdgeSchema = z
  .object({
    fromNodeId: containedComponentIdSchema,
    port: ruleGraphPortSchema,
    toNodeId: containedComponentIdSchema,
  })
  .strict();
export type RuleGraphEdge = z.infer<typeof ruleGraphEdgeSchema>;

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

export const ruleGraphSchema = z
  .object({
    ruleId: ruleIdSchema,
    key: builderKeySchema,
    subjectRecordTypeId: recordTypeIdSchema,
    profile: z.literal("before_save"),
    graphVersion: z.literal(ruleGraphContractVersion),
    priority: z.number().int().min(0).max(10_000),
    inputs: z.array(ruleGraphInputDeclarationSchema).max(100),
    variables: z.array(ruleGraphVariableDeclarationSchema).max(100),
    nodes: z.array(ruleGraphNodeSchema).min(1).max(100),
    edges: z.array(ruleGraphEdgeSchema).max(200),
  })
  .strict()
  .superRefine((value, context) => {
    reportDuplicate(
      value.inputs.map((input) => input.inputId),
      "inputs",
      context,
      "Rule input identities must be unique",
    );
    reportDuplicate(
      value.inputs.map((input) => input.key),
      "inputs",
      context,
      "Rule input keys must be unique",
    );
    reportDuplicate(
      value.variables.map((variable) => variable.variableId),
      "variables",
      context,
      "Rule variable identities must be unique",
    );
    reportDuplicate(
      value.variables.map((variable) => variable.key),
      "variables",
      context,
      "Rule variable keys must be unique",
    );
    reportDuplicate(
      value.nodes.map((node) => node.nodeId),
      "nodes",
      context,
      "Rule node identities must be unique",
    );
    const orderedLists = [
      { path: "inputs", values: value.inputs.map((input) => input.inputId) },
      { path: "variables", values: value.variables.map((variable) => variable.variableId) },
      { path: "nodes", values: value.nodes.map((node) => node.nodeId) },
      {
        path: "edges",
        values: value.edges.map((edge) => `${edge.fromNodeId}:${edge.port}:${edge.toNodeId}`),
      },
    ];
    for (const ordered of orderedLists)
      if (ordered.values.some((item, index) => index > 0 && ordered.values[index - 1]! >= item))
        context.addIssue({
          code: "custom",
          path: [ordered.path],
          message: `Canonical rule ${ordered.path} must use identity order`,
        });
    reportDuplicate(
      value.edges.map((edge) => `${edge.fromNodeId}:${edge.port}`),
      "edges",
      context,
      "A rule node port may have only one outgoing edge",
    );
  });
export type RuleGraph = z.infer<typeof ruleGraphSchema>;
