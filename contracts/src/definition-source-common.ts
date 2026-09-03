import { z } from "zod";
import { builderKeySchema, namespacedKeySchema } from "./identifiers";
import {
  conditionMaximumNestingDepth,
  conditionMaximumOperandCount,
  jsonValueSchema,
} from "./common";

/** Portable aliases exist only in authored definitions. #15 resolves them to platform identifiers. */
export const sourceAliasSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z][a-z0-9_]*$/);
export const sourceQualifiedRecordTypeSchema = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[a-z][a-z0-9_.]*:[a-z][a-z0-9_]*$/);
export const sourceQualifiedFieldSchema = z
  .string()
  .min(5)
  .max(250)
  .regex(/^[a-z][a-z0-9_.]*:[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
export const sourceQualifiedRelationshipSchema = z
  .string()
  .min(5)
  .max(250)
  .regex(/^[a-z][a-z0-9_.]*:[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
export const definitionSourceContractVersion = "1.0.0" as const;
const sourceBinaryConditionOperatorSchema = z.enum([
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
const sourceUnaryConditionOperatorSchema = z.enum(["is_empty", "is_not_empty"]);
const sourceConditionOperandSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("field"), field: builderKeySchema }).strict(),
  z.object({ source: z.literal("value"), value: jsonValueSchema }).strict(),
  z.object({ source: z.literal("parameter"), parameter: builderKeySchema }).strict(),
]);
const sourceQualifiedConditionOperandSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("field"), field: sourceQualifiedFieldSchema }).strict(),
  z.object({ source: z.literal("value"), value: jsonValueSchema }).strict(),
  z.object({ source: z.literal("parameter"), parameter: builderKeySchema }).strict(),
]);

/**
 * The compact field/value and field/parameter forms remain convenient for authored JSON. The
 * explicit operand form is the complete representation and permits field-to-field comparisons.
 */
export const sourceComparisonSchema = z.union([
  z.object({ field: builderKeySchema, operator: z.enum(["is_empty", "is_not_empty"]) }).strict(),
  z
    .object({
      field: builderKeySchema,
      operator: sourceBinaryConditionOperatorSchema,
      value: jsonValueSchema,
    })
    .strict(),
  z
    .object({
      field: builderKeySchema,
      operator: sourceBinaryConditionOperatorSchema,
      parameter: builderKeySchema,
    })
    .strict(),
  z
    .object({
      operator: sourceUnaryConditionOperatorSchema,
      left: sourceConditionOperandSchema,
    })
    .strict(),
  z
    .object({
      operator: sourceBinaryConditionOperatorSchema,
      left: sourceConditionOperandSchema,
      right: sourceConditionOperandSchema,
    })
    .strict(),
]);
export type SourceCondition =
  | z.infer<typeof sourceComparisonSchema>
  | { all: SourceCondition[] }
  | { any: SourceCondition[] }
  | { not: SourceCondition };
const sourceConditionTreeSchema: z.ZodType<SourceCondition> = z.lazy(() =>
  z.union([
    sourceComparisonSchema,
    z.object({ all: z.array(sourceConditionTreeSchema).min(1).max(50) }).strict(),
    z.object({ any: z.array(sourceConditionTreeSchema).min(1).max(50) }).strict(),
    z.object({ not: sourceConditionTreeSchema }).strict(),
  ]),
);
const inspectSourceCondition = (
  condition: SourceCondition,
  depth = 1,
): { depth: number; operands: number } => {
  if ("all" in condition || "any" in condition) {
    const children = "all" in condition ? condition.all : condition.any;
    const inspected = children.map((child) => inspectSourceCondition(child, depth + 1));
    return {
      depth: Math.max(depth, ...inspected.map((child) => child.depth)),
      operands: inspected.reduce((total, child) => total + child.operands, 0),
    };
  }
  if ("not" in condition) return inspectSourceCondition(condition.not, depth + 1);
  if ("left" in condition) return { depth, operands: "right" in condition ? 2 : 1 };
  return {
    depth,
    operands: "operator" in condition && condition.operator.startsWith("is_") ? 1 : 2,
  };
};
export const sourceConditionSchema: z.ZodType<SourceCondition> =
  sourceConditionTreeSchema.superRefine((condition, context) => {
    const inspected = inspectSourceCondition(condition);
    if (inspected.depth > conditionMaximumNestingDepth)
      context.addIssue({
        code: "custom",
        message: `Condition nesting cannot exceed ${conditionMaximumNestingDepth} levels`,
      });
    if (inspected.operands > conditionMaximumOperandCount)
      context.addIssue({
        code: "custom",
        message: `Condition operands cannot exceed ${conditionMaximumOperandCount}`,
      });
  });
const sourceQualifiedComparisonSchema = z.union([
  z
    .object({
      field: sourceQualifiedFieldSchema,
      operator: sourceUnaryConditionOperatorSchema,
    })
    .strict(),
  z
    .object({
      field: sourceQualifiedFieldSchema,
      operator: sourceBinaryConditionOperatorSchema,
      value: jsonValueSchema,
    })
    .strict(),
  z
    .object({
      field: sourceQualifiedFieldSchema,
      operator: sourceBinaryConditionOperatorSchema,
      parameter: builderKeySchema,
    })
    .strict(),
  z
    .object({
      operator: sourceUnaryConditionOperatorSchema,
      left: sourceQualifiedConditionOperandSchema,
    })
    .strict(),
  z
    .object({
      operator: sourceBinaryConditionOperatorSchema,
      left: sourceQualifiedConditionOperandSchema,
      right: sourceQualifiedConditionOperandSchema,
    })
    .strict(),
]);
export type SourceQualifiedCondition =
  | z.infer<typeof sourceQualifiedComparisonSchema>
  | { all: SourceQualifiedCondition[] }
  | { any: SourceQualifiedCondition[] }
  | { not: SourceQualifiedCondition };
const sourceQualifiedConditionTreeSchema: z.ZodType<SourceQualifiedCondition> = z.lazy(() =>
  z.union([
    sourceQualifiedComparisonSchema,
    z.object({ all: z.array(sourceQualifiedConditionTreeSchema).min(1).max(50) }).strict(),
    z.object({ any: z.array(sourceQualifiedConditionTreeSchema).min(1).max(50) }).strict(),
    z.object({ not: sourceQualifiedConditionTreeSchema }).strict(),
  ]),
);
export const sourceQualifiedConditionSchema: z.ZodType<SourceQualifiedCondition> =
  sourceQualifiedConditionTreeSchema.superRefine((condition, context) => {
    const inspected = inspectSourceCondition(condition as SourceCondition);
    if (inspected.depth > conditionMaximumNestingDepth)
      context.addIssue({
        code: "custom",
        message: `Condition nesting cannot exceed ${conditionMaximumNestingDepth} levels`,
      });
    if (inspected.operands > conditionMaximumOperandCount)
      context.addIssue({
        code: "custom",
        message: `Condition operands cannot exceed ${conditionMaximumOperandCount}`,
      });
  });
export const sourceActionValueSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("literal"), value: jsonValueSchema }).strict(),
  z.object({ source: z.literal("input"), input: builderKeySchema }).strict(),
  z.object({ source: z.literal("subject_field"), field: builderKeySchema }).strict(),
  z.object({ source: z.literal("subject_record") }).strict(),
  z.object({ source: z.literal("current_actor") }).strict(),
  z.object({ source: z.literal("current_time") }).strict(),
]);
export const sourceActionEffectSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("set_field"),
      field: builderKeySchema,
      value: sourceActionValueSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("create_record"),
      record_type: sourceQualifiedRecordTypeSchema,
      values: z.record(builderKeySchema, sourceActionValueSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal("copy_relationships"),
      relationships: z.array(builderKeySchema).min(1),
      target_input: builderKeySchema,
    })
    .strict(),
  z.object({ kind: z.literal("soft_delete_subject") }).strict(),
  z.object({ kind: z.literal("announce_event"), event: namespacedKeySchema }).strict(),
]);
export const sourceRuleEffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("refuse"), reason_code: builderKeySchema }).strict(),
  z
    .object({ kind: z.literal("set_value"), field: builderKeySchema, value: jsonValueSchema })
    .strict(),
  z.object({ kind: z.literal("require"), field: builderKeySchema }).strict(),
  z
    .object({
      kind: z.literal("show_or_hide"),
      component: sourceAliasSchema,
      visibility: z.enum(["show", "hide"]),
    })
    .strict(),
  z.object({ kind: z.literal("warn"), message: builderKeySchema }).strict(),
  z.object({ kind: z.literal("start_background_work"), workflow: builderKeySchema }).strict(),
]);

export const authoredSourceBase = {
  source_contract_version: z.literal(definitionSourceContractVersion),
  root_alias: sourceAliasSchema,
  key: namespacedKeySchema,
};
