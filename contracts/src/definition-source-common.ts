import { z } from "zod";
import { builderKeySchema, namespacedKeySchema } from "./identifiers";
import {
  conditionMaximumNestingDepth,
  conditionMaximumOperandCount,
  jsonValueSchema,
} from "./common";
import { flowValueSchema } from "./flow-contracts";

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
/**
 * A query an application binds is always one a bound Module exposes, named by that Module's key
 * and the query's own key ("vortex.crm.organisations:crm_companies"). An application never owns a
 * query the Query engine cannot run.
 */
export const sourceQualifiedQueryReferenceSchema = z
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
/**
 * The task ids of one named action's ordered task list. Each id becomes the id of its compiled
 * flow task, so the ids are unique within the action and never one the compiled flow reserves for
 * the precondition.
 */
export const refineActionTaskIds = (
  tasks: readonly Readonly<{ id: string }>[],
  context: z.RefinementCtx,
): void => {
  const seen = new Set<string>();
  for (const [index, task] of tasks.entries()) {
    if (seen.has(task.id) || task.id === "precondition" || task.id === "precondition_refused")
      context.addIssue({
        code: "custom",
        path: [index, "id"],
        message: "An action task id is unique within the action and not a reserved flow task id",
      });
    seen.add(task.id);
  }
};
/**
 * One registry record task of an authored Module or Application action. The task type and property
 * names are the flow task registry's, and each property value uses the same flow value grammar as
 * an authored flow (`flowValueSchema`). The `values` property is the flow `field_values` map: its
 * keys are field aliases of the task's record type and each entry is a flow value, so `input`,
 * subject-field and actor/time reads are the same closed references a flow authors.
 */
export const sourceActionTaskSchema = z.discriminatedUnion("type", [
  z
    .object({
      id: builderKeySchema,
      type: z.literal("record.set_fields"),
      properties: z
        .object({ values: z.record(builderKeySchema, flowValueSchema) })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: builderKeySchema,
      type: z.literal("record.create"),
      properties: z
        .object({
          record_type: sourceQualifiedRecordTypeSchema,
          values: z.record(builderKeySchema, flowValueSchema),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: builderKeySchema,
      type: z.literal("record.changes"),
      properties: z
        .object({
          changes: z
            .array(
              z
                .object({
                  kind: z.literal("copy_relationships"),
                  relationships: z.array(builderKeySchema).min(1),
                  target_input: builderKeySchema,
                })
                .strict(),
            )
            .min(1)
            .max(10),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: builderKeySchema,
      type: z.literal("record.delete"),
      properties: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      id: builderKeySchema,
      type: z.literal("event.announce"),
      properties: z.object({ event: namespacedKeySchema }).strict(),
    })
    .strict(),
]);

export const authoredSourceBase = {
  source_contract_version: z.literal(definitionSourceContractVersion),
  root_alias: sourceAliasSchema,
  key: namespacedKeySchema,
};
