import { z } from "zod";
import { builderKeySchema, namespacedKeySchema } from "./identifiers";
import {
  conditionMaximumNestingDepth,
  conditionMaximumOperandCount,
  jsonValueSchema,
} from "./common";
import { flowValueSchema } from "./flow-contracts";
import { sourceNamedActionQueryValueSchema } from "./named-action-query-values";

export type SourceProvenanceAnnotation = Readonly<{
  /** Canonical path suffixes; use `#` for an array index and `**` for descendant paths. */
  canonicalTargets: readonly string[];
  /** Apply this target to parsed source leaves below the annotated property. */
  includeDescendants?: boolean;
}>;

export const sourceProvenanceRegistry = z.registry<SourceProvenanceAnnotation>();

/** Attach provenance targets to one authored source property without changing its parse shape. */
export const sourceProvenanceTarget = <Schema extends z.ZodType>(
  schema: Schema,
  canonicalTargets: string | readonly string[],
  includeDescendants = false,
): Schema => {
  const annotatedSchema =
    schema === jsonValueSchema ? z.preprocess((value) => value, schema) : schema.clone();
  return annotatedSchema.register(sourceProvenanceRegistry, {
    canonicalTargets: typeof canonicalTargets === "string" ? [canonicalTargets] : canonicalTargets,
    ...(includeDescendants ? { includeDescendants: true } : {}),
  }) as unknown as Schema;
};

/** Mark a source property whose value cannot authorize a canonical transformation. */
export const sourceProvenanceUnchanged = <Schema extends z.ZodType>(
  schema: Schema,
  includeDescendants = false,
): Schema => sourceProvenanceTarget(schema, [], includeDescendants);

/** Refuse an incomplete source schema when contracts are loaded for compilation. */
export const assertSourceProvenanceCoverage = (roots: readonly z.core.$ZodType[]): void => {
  const seenSchemas = new WeakSet<z.core.$ZodType>();
  const seenLazyGetters = new WeakSet<() => z.core.$ZodType>();
  const missing: string[] = [];
  const inspect = (schema: z.core.$ZodType, path: readonly string[]): void => {
    if (seenSchemas.has(schema)) return;
    seenSchemas.add(schema);
    if (schema === jsonValueSchema || sourceProvenanceRegistry.get(schema)?.includeDescendants)
      return;
    const definition = (schema as z.core.$ZodTypes)._zod.def;
    switch (definition.type) {
      case "object":
        for (const [key, child] of Object.entries(definition.shape)) {
          if (!sourceProvenanceRegistry.get(child)) missing.push([...path, key].join("/"));
          inspect(child, [...path, key]);
        }
        return;
      case "array":
        inspect(definition.element, [...path, "#"]);
        return;
      case "record":
        inspect(definition.valueType, [...path, "*"]);
        return;
      case "tuple":
        definition.items.forEach((child, index) => inspect(child, [...path, String(index)]));
        if (definition.rest) inspect(definition.rest, [...path, "*"]);
        return;
      case "union":
        definition.options.forEach((child, index) => inspect(child, [...path, `option${index}`]));
        return;
      case "pipe":
        inspect(definition.out, path);
        return;
      case "lazy":
        if (!seenLazyGetters.has(definition.getter)) {
          seenLazyGetters.add(definition.getter);
          inspect(definition.getter(), path);
        }
        return;
      case "optional":
      case "nullable":
      case "default":
      case "readonly":
        inspect(definition.innerType, path);
        return;
      default:
        return;
    }
  };
  roots.forEach((schema, index) => inspect(schema, [String(index)]));
  if (missing.length)
    throw new TypeError(`Source provenance annotations missing: ${missing.join(", ")}`);
};

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
  z
    .object({
      source: sourceProvenanceUnchanged(z.literal("field")),
      field: sourceProvenanceTarget(builderKeySchema, ["kind", "left/fieldId", "right/fieldId"]),
    })
    .strict(),
  z
    .object({
      source: sourceProvenanceUnchanged(z.literal("value")),
      value: sourceProvenanceTarget(
        jsonValueSchema,
        ["kind", "left/value/**", "right/value/**"],
        true,
      ),
    })
    .strict(),
  z
    .object({
      source: sourceProvenanceUnchanged(z.literal("parameter")),
      parameter: sourceProvenanceTarget(builderKeySchema, ["kind", "left/key", "right/key"]),
    })
    .strict(),
]);
const sourceQualifiedConditionOperandSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: sourceProvenanceUnchanged(z.literal("field")),
      field: sourceProvenanceTarget(sourceQualifiedFieldSchema, [
        "kind",
        "left/fieldId",
        "right/fieldId",
      ]),
    })
    .strict(),
  z
    .object({
      source: sourceProvenanceUnchanged(z.literal("value")),
      value: sourceProvenanceTarget(
        jsonValueSchema,
        ["kind", "left/value/**", "right/value/**"],
        true,
      ),
    })
    .strict(),
  z
    .object({
      source: sourceProvenanceUnchanged(z.literal("parameter")),
      parameter: sourceProvenanceTarget(builderKeySchema, ["kind", "left/key", "right/key"]),
    })
    .strict(),
]);

/**
 * The compact field/value and field/parameter forms remain convenient for authored JSON. The
 * explicit operand form is the complete representation and permits field-to-field comparisons.
 */
export const sourceComparisonSchema = z.union([
  z
    .object({
      field: sourceProvenanceTarget(builderKeySchema, ["kind", "left/source", "left/fieldId"]),
      operator: sourceProvenanceTarget(z.enum(["is_empty", "is_not_empty"]), ["kind", "operator"]),
    })
    .strict(),
  z
    .object({
      field: sourceProvenanceTarget(builderKeySchema, ["kind", "left/source", "left/fieldId"]),
      operator: sourceProvenanceTarget(sourceBinaryConditionOperatorSchema, ["kind", "operator"]),
      value: sourceProvenanceTarget(
        jsonValueSchema,
        ["kind", "right/source", "right/value/**"],
        true,
      ),
    })
    .strict(),
  z
    .object({
      field: sourceProvenanceTarget(builderKeySchema, ["kind", "left/source", "left/fieldId"]),
      operator: sourceProvenanceTarget(sourceBinaryConditionOperatorSchema, ["kind", "operator"]),
      parameter: sourceProvenanceTarget(builderKeySchema, ["right/source", "right/key"]),
    })
    .strict(),
  z
    .object({
      operator: sourceProvenanceTarget(sourceUnaryConditionOperatorSchema, ["kind", "operator"]),
      left: sourceProvenanceUnchanged(sourceConditionOperandSchema),
    })
    .strict(),
  z
    .object({
      operator: sourceProvenanceTarget(sourceBinaryConditionOperatorSchema, ["kind", "operator"]),
      left: sourceProvenanceUnchanged(sourceConditionOperandSchema),
      right: sourceProvenanceUnchanged(sourceConditionOperandSchema),
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
    z
      .object({ all: sourceProvenanceUnchanged(z.array(sourceConditionTreeSchema).min(1).max(50)) })
      .strict(),
    z
      .object({ any: sourceProvenanceUnchanged(z.array(sourceConditionTreeSchema).min(1).max(50)) })
      .strict(),
    z.object({ not: sourceProvenanceUnchanged(sourceConditionTreeSchema) }).strict(),
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
      field: sourceProvenanceTarget(sourceQualifiedFieldSchema, [
        "kind",
        "left/source",
        "left/fieldId",
      ]),
      operator: sourceProvenanceTarget(sourceUnaryConditionOperatorSchema, ["kind", "operator"]),
    })
    .strict(),
  z
    .object({
      field: sourceProvenanceTarget(sourceQualifiedFieldSchema, [
        "kind",
        "left/source",
        "left/fieldId",
      ]),
      operator: sourceProvenanceTarget(sourceBinaryConditionOperatorSchema, ["kind", "operator"]),
      value: sourceProvenanceTarget(
        jsonValueSchema,
        ["kind", "right/source", "right/value/**"],
        true,
      ),
    })
    .strict(),
  z
    .object({
      field: sourceProvenanceTarget(sourceQualifiedFieldSchema, [
        "kind",
        "left/source",
        "left/fieldId",
      ]),
      operator: sourceProvenanceTarget(sourceBinaryConditionOperatorSchema, ["kind", "operator"]),
      parameter: sourceProvenanceTarget(builderKeySchema, ["right/source", "right/key"]),
    })
    .strict(),
  z
    .object({
      operator: sourceProvenanceTarget(sourceUnaryConditionOperatorSchema, ["kind", "operator"]),
      left: sourceProvenanceUnchanged(sourceQualifiedConditionOperandSchema),
    })
    .strict(),
  z
    .object({
      operator: sourceProvenanceTarget(sourceBinaryConditionOperatorSchema, ["kind", "operator"]),
      left: sourceProvenanceUnchanged(sourceQualifiedConditionOperandSchema),
      right: sourceProvenanceUnchanged(sourceQualifiedConditionOperandSchema),
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
    z
      .object({
        all: sourceProvenanceUnchanged(z.array(sourceQualifiedConditionTreeSchema).min(1).max(50)),
      })
      .strict(),
    z
      .object({
        any: sourceProvenanceUnchanged(z.array(sourceQualifiedConditionTreeSchema).min(1).max(50)),
      })
      .strict(),
    z.object({ not: sourceProvenanceUnchanged(sourceQualifiedConditionTreeSchema) }).strict(),
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
 * A set-fields value may also bind one protected complete Query reduction; the Module compiler
 * resolves those identities and the named Record service consumes it without extending Flow.
 */
export const sourceActionTaskSchema = z.discriminatedUnion("type", [
  z
    .object({
      id: sourceProvenanceUnchanged(builderKeySchema),
      type: sourceProvenanceUnchanged(z.literal("record.set_fields")),
      properties: sourceProvenanceUnchanged(
        z
          .object({
            values: sourceProvenanceTarget(
              z.record(builderKeySchema, z.union([flowValueSchema, sourceNamedActionQueryValueSchema])),
              ["values/**"],
              true,
            ),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      id: sourceProvenanceUnchanged(builderKeySchema),
      type: sourceProvenanceUnchanged(z.literal("record.create")),
      properties: sourceProvenanceUnchanged(
        z
          .object({
            record_type: sourceProvenanceTarget(sourceQualifiedRecordTypeSchema, ["recordType/**"]),
            values: sourceProvenanceTarget(
              z.record(builderKeySchema, flowValueSchema),
              ["values/**"],
              true,
            ),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      id: sourceProvenanceUnchanged(builderKeySchema),
      type: sourceProvenanceUnchanged(z.literal("record.changes")),
      properties: sourceProvenanceUnchanged(
        z
          .object({
            changes: sourceProvenanceUnchanged(
              z
                .array(
                  z
                    .object({
                      kind: sourceProvenanceUnchanged(z.literal("copy_relationships")),
                      relationships: sourceProvenanceTarget(
                        z.array(builderKeySchema).min(1),
                        ["relationshipIds/#"],
                        true,
                      ),
                      target_input: sourceProvenanceTarget(builderKeySchema, ["targetInputKey"]),
                    })
                    .strict(),
                )
                .min(1)
                .max(10),
            ),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      id: sourceProvenanceUnchanged(builderKeySchema),
      type: sourceProvenanceUnchanged(z.literal("record.delete")),
      properties: sourceProvenanceUnchanged(z.object({}).strict()),
    })
    .strict(),
  z
    .object({
      id: sourceProvenanceUnchanged(builderKeySchema),
      type: sourceProvenanceUnchanged(z.literal("event.announce")),
      properties: sourceProvenanceUnchanged(
        z.object({ event: sourceProvenanceTarget(namespacedKeySchema, ["eventKey"]) }).strict(),
      ),
    })
    .strict(),
]);

export const authoredSourceBase = {
  source_contract_version: sourceProvenanceUnchanged(z.literal(definitionSourceContractVersion)),
  root_alias: sourceProvenanceTarget(sourceAliasSchema, ["rootId", "connectionTypeId"]),
  key: sourceProvenanceUnchanged(namespacedKeySchema),
};
