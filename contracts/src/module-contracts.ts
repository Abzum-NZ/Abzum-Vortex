import { z } from "zod";
import { conditionMaximumNestingDepth, conditionMaximumOperandCount, jsonValueSchema } from "./common";
import {
  applicationRootIdSchema,
  builderKeySchema,
  containedComponentIdSchema,
  eventDeclarationIdSchema,
  eventIdSchema,
  fieldIdSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  recordTypeIdSchema,
  semanticVersionSchema,
} from "./identifiers";
import { recordTypeReferenceSchema, versionRequirementSchema } from "./definitions";

const parentDeleteSchema = z.enum(["refuse", "empty_optional", "soft_delete_dependent"]);

export const moduleDependencySchema = z
  .object({
    dependencyKey: builderKeySchema,
    moduleRootId: moduleRootIdSchema,
    moduleKey: namespacedKeySchema,
    version: versionRequirementSchema,
    resolvedVersion: semanticVersionSchema,
  })
  .strict();

export const relationshipDefinitionSchema = z
  .object({
    relationshipId: containedComponentIdSchema,
    key: builderKeySchema,
    fromRecordTypeId: recordTypeIdSchema,
    fromFieldId: fieldIdSchema,
    toRecordType: recordTypeReferenceSchema.optional(),
    toRecordTypes: z.array(recordTypeReferenceSchema).min(2).max(20).optional(),
    cardinality: z.enum(["one_to_one", "many_to_one", "many_to_many"]),
    onParentDelete: parentDeleteSchema,
  })
  .strict()
  .refine((value) => (value.toRecordType !== undefined) !== (value.toRecordTypes !== undefined), {
    path: ["toRecordType"],
    message: "A relationship must declare one target or a polymorphic target list",
  });

const conditionOperandSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("field"), fieldId: fieldIdSchema }).strict(),
  z.object({ source: z.literal("value"), value: jsonValueSchema }).strict(),
  z.object({ source: z.literal("parameter"), key: builderKeySchema }).strict(),
]);
const comparisonConditionSchema = z
  .object({
    kind: z.literal("comparison"),
    operator: z.enum([
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
      "is_empty",
      "is_not_empty",
    ]),
    left: conditionOperandSchema,
    right: conditionOperandSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const unary = value.operator === "is_empty" || value.operator === "is_not_empty";
    if (unary && value.right !== undefined)
      context.addIssue({
        code: "custom",
        path: ["right"],
        message: "An empty-value comparison has exactly one operand",
      });
    if (!unary && value.right === undefined)
      context.addIssue({
        code: "custom",
        path: ["right"],
        message: "A binary comparison requires two operands",
      });
  });
export type ConditionNode =
  | z.infer<typeof comparisonConditionSchema>
  | { kind: "all" | "any"; conditions: ConditionNode[] }
  | { kind: "not"; condition: ConditionNode };
const conditionNodeTreeSchema: z.ZodType<ConditionNode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    comparisonConditionSchema,
    z
      .object({
        kind: z.literal("all"),
        conditions: z.array(conditionNodeTreeSchema).min(1).max(50),
      })
      .strict(),
    z
      .object({
        kind: z.literal("any"),
        conditions: z.array(conditionNodeTreeSchema).min(1).max(50),
      })
      .strict(),
    z.object({ kind: z.literal("not"), condition: conditionNodeTreeSchema }).strict(),
  ]),
);
const inspectCondition = (
  condition: ConditionNode,
  depth = 1,
): { depth: number; operands: number } => {
  if (condition.kind === "comparison")
    return { depth, operands: condition.right === undefined ? 1 : 2 };
  if (condition.kind === "not") return inspectCondition(condition.condition, depth + 1);
  const inspected = condition.conditions.map((child) => inspectCondition(child, depth + 1));
  return {
    depth: Math.max(depth, ...inspected.map((child) => child.depth)),
    operands: inspected.reduce((total, child) => total + child.operands, 0),
  };
};
export const conditionNodeSchema: z.ZodType<ConditionNode> = conditionNodeTreeSchema.superRefine(
  (condition, context) => {
    const inspected = inspectCondition(condition);
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
  },
);

/**
 * The value grammar a named-action task property reads. A value is a literal, one of the action's
 * declared inputs, one of the subject record's fields, the whole subject record, the current actor
 * or the one checked execution time. It is the authored grammar resolved to permanent identities;
 * moving it to the flow value grammar is a follow-up.
 */
const actionTaskValueSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("literal"), value: jsonValueSchema }).strict(),
  z.object({ source: z.literal("input"), inputKey: builderKeySchema }).strict(),
  z.object({ source: z.literal("subject_field"), fieldId: fieldIdSchema }).strict(),
  z.object({ source: z.literal("subject_record") }).strict(),
  z.object({ source: z.literal("current_actor") }).strict(),
  z.object({ source: z.literal("current_time") }).strict(),
]);

/**
 * One registry record task of a canonical Module or Application action, in authored order. A named
 * action's ordered task list is the one home of its behaviour; each task compiles into the same
 * registry record task of the action's `transaction` flow. The task type names and property names
 * are the flow task registry's, while each property value keeps the action value grammar above.
 */
export const actionTaskSchema = z.discriminatedUnion("type", [
  z
    .object({
      id: builderKeySchema,
      type: z.literal("record.set_fields"),
      properties: z.object({ values: z.record(fieldIdSchema, actionTaskValueSchema) }).strict(),
    })
    .strict(),
  z
    .object({
      id: builderKeySchema,
      type: z.literal("record.create"),
      properties: z
        .object({
          recordType: recordTypeReferenceSchema,
          values: z.record(fieldIdSchema, actionTaskValueSchema),
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
                  relationshipIds: z.array(containedComponentIdSchema).min(1),
                  targetInputKey: builderKeySchema,
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
      properties: z.object({ eventKey: namespacedKeySchema }).strict(),
    })
    .strict(),
]);

export const eventDefinitionSchema = z
  .object({
    eventId: eventIdSchema,
    key: namespacedKeySchema,
    recordTypeId: recordTypeIdSchema,
    carriedFieldIds: z.array(fieldIdSchema).max(30),
    personalOrSensitiveValuesAllowed: z.literal(false),
  })
  .strict();

export const standardInstalledEventKindSchema = z.enum([
  "created",
  "changed",
  "deleted",
  "linked",
  "unlinked",
  "reassigned",
  "state_changed",
]);

const canonicalCarriedFieldIdsSchema = z
  .array(fieldIdSchema)
  .max(30)
  .superRefine((fieldIds, context) => {
    if (new Set(fieldIds).size !== fieldIds.length)
      context.addIssue({ code: "custom", message: "Carried field identities must be unique" });
    if (fieldIds.some((fieldId, index) => index > 0 && fieldIds[index - 1]! >= fieldId))
      context.addIssue({
        code: "custom",
        message: "Carried field identities must use canonical order",
      });
  });

const installedEventOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("application"), applicationRootId: applicationRootIdSchema }).strict(),
  z.object({ kind: z.literal("module"), moduleRootId: moduleRootIdSchema }).strict(),
]);

export const standardInstalledEventDescriptorSchema = z
  .object({
    kind: z.literal("standard"),
    eventKind: standardInstalledEventKindSchema,
    recordTypeId: recordTypeIdSchema,
  })
  .strict();

export const declaredInstalledEventDescriptorSchema = z
  .object({
    kind: z.literal("declared"),
    owner: installedEventOwnerSchema,
    declarationId: eventDeclarationIdSchema,
    key: namespacedKeySchema,
    recordTypeId: recordTypeIdSchema,
    carriedFieldIds: canonicalCarriedFieldIdsSchema,
  })
  .strict();

/**
 * Closed declaration identity projected from immutable installed definitions.
 * Installation binding and exact release evidence are catalogue context, not
 * synthetic properties of this reusable descriptor.
 */
export const installedEventDescriptorSchema = z.discriminatedUnion("kind", [
  standardInstalledEventDescriptorSchema,
  declaredInstalledEventDescriptorSchema,
]);


export type ModuleDependency = z.infer<typeof moduleDependencySchema>;
export type RelationshipDefinition = z.infer<typeof relationshipDefinitionSchema>;
export type Condition = z.infer<typeof conditionNodeSchema>;
export type EventDefinition = z.infer<typeof eventDefinitionSchema>;
export type StandardInstalledEventKind = z.infer<typeof standardInstalledEventKindSchema>;
export type StandardInstalledEventDescriptor = z.infer<
  typeof standardInstalledEventDescriptorSchema
>;
export type DeclaredInstalledEventDescriptor = z.infer<
  typeof declaredInstalledEventDescriptorSchema
>;
export type InstalledEventDescriptor = z.infer<typeof installedEventDescriptorSchema>;
