import { z } from "zod";
import { workflowValueTypeSchema } from "./catalogues";
import { descriptionSchema, jsonValueSchema, retryPolicySchema } from "./common";
import { definitionProvenanceEntrySchema } from "./definition-provenance";
import {
  flowContractVersion,
  flowExecutionKindSchema,
  flowFormulaSchema,
  flowLiteralSchema,
  flowMaximumTaskCount,
  flowRegisteredTaskTypeSchema,
  flowScheduleRecurrenceSchema,
  flowSchema,
  flowStandardEventKindSchema,
  flowTaskTimeoutSchema,
  flowValueSchema,
} from "./flow-contracts";
import type { FlowFormula, FlowLiteral, FlowValue } from "./flow-contracts";
import {
  builderKeySchema,
  namespacedKeySchema,
  stableDefinitionReleaseVersionSchema,
} from "./identifiers";

/**
 * The authored form of a flow inside a module or application source, and the result of compiling
 * a set of them (architecture decision 1; issue #984).
 *
 * The authored flow has exactly the canonical flow's shape (`flow-contracts.ts`), with one
 * difference: wherever the canonical flow holds a permanent identity, the source holds a readable
 * alias. The flow's own `id` is its owner alias and `key` its readable key; both resolve to the one
 * permanent flow identity in the resolution snapshot. A record type is written `key` (owned by the
 * same definition) or `definition.key:key` (owned by a declared dependency). A field named by a
 * task is written `<record type reference>.<field alias>`, so no field is ever guessed from
 * context. Flow structure, limits and value grammar are not restated here: the compiled flow is
 * parsed by `flowSchema`, which owns them.
 *
 * Nothing in a source flow carries release evidence. Exact releases of the definitions a flow
 * depends on are recorded once, in the compilation's dependency manifest.
 */
export const flowSourceContractVersion = "1.0.0" as const;

/** A readable alias or owner id. It can never carry template delimiters. */
export const flowAliasSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => !/\{\{|\{%/.test(value), {
    message: "An alias cannot contain template delimiters",
  });
export type FlowAlias = z.infer<typeof flowAliasSchema>;

const boundedRecord = <Value extends z.ZodType>(value: Value, maximum: number) =>
  z.record(builderKeySchema, value).refine((record) => Object.keys(record).length <= maximum, {
    message: `At most ${maximum} entries are allowed`,
  });

const textSchema = (maximum: number) => z.string().min(1).max(maximum);

// ─── Declarations, triggers and run as ───────────────────────────────────────────────────────

const sourceDeclarationShape = {
  type: workflowValueTypeSchema,
  recordTypeIds: z.array(flowAliasSchema).min(1).max(20).optional(),
  description: textSchema(300).optional(),
  default: jsonValueSchema.optional(),
};

const sourceInputDeclarationSchema = z
  .object({ ...sourceDeclarationShape, required: z.boolean() })
  .strict();
const sourceVariableDeclarationSchema = z.object(sourceDeclarationShape).strict();
const sourceOutputDeclarationSchema = z
  .object({
    type: workflowValueTypeSchema,
    recordTypeIds: sourceDeclarationShape.recordTypeIds,
    value: flowValueSchema,
  })
  .strict();

const sourceTriggerCommonShape = {
  id: builderKeySchema,
  inputs: boundedRecord(sourceInputDeclarationSchema, 100).default({}),
  condition: flowFormulaSchema.optional(),
};

const sourceBeforeSaveOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create") }).strict(),
  z.object({ kind: z.literal("update") }).strict(),
  z.object({ kind: z.literal("transition"), actionId: flowAliasSchema }).strict(),
]);

export const sourceFlowTriggerSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...sourceTriggerCommonShape,
      type: z.literal("BeforeSave"),
      recordTypeId: flowAliasSchema,
      operations: z.array(sourceBeforeSaveOperationSchema).min(1).max(20),
      priority: z.number().int().min(0).max(1_000),
    })
    .strict(),
  z
    .object({
      ...sourceTriggerCommonShape,
      type: z.literal("Event"),
      recordTypeId: flowAliasSchema,
      event: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("standard"), eventKind: flowStandardEventKindSchema }).strict(),
        z.object({ kind: z.literal("declared"), eventKey: namespacedKeySchema }).strict(),
      ]),
      duplicateProtection: z.literal("committed_occurrence"),
    })
    .strict(),
  z
    .object({
      ...sourceTriggerCommonShape,
      type: z.literal("Schedule"),
      recurrence: flowScheduleRecurrenceSchema,
      duplicateProtection: z.literal("scheduled_instant"),
    })
    .strict(),
  z
    .object({
      ...sourceTriggerCommonShape,
      type: z.literal("IncomingMessage"),
      messageKey: builderKeySchema,
      duplicateProtection: z.literal("verified_message"),
    })
    .strict(),
]);
export type SourceFlowTrigger = z.infer<typeof sourceFlowTriggerSchema>;

export const sourceFlowRunAsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("initiator") }).strict(),
  z.object({ kind: z.literal("saver") }).strict(),
  z
    .object({ kind: z.literal("specified_account"), executionBindingId: flowAliasSchema })
    .strict(),
  z.object({ kind: z.literal("system"), executionBindingId: flowAliasSchema }).strict(),
]);

// ─── Tasks ───────────────────────────────────────────────────────────────────────────────────

type SourceFlowTaskCommon = {
  id: string;
  description?: string | undefined;
  retry?: z.infer<typeof retryPolicySchema> | undefined;
  timeout?: z.infer<typeof flowTaskTimeoutSchema> | undefined;
};
export type SourceFlowTask = SourceFlowTaskCommon &
  (
    | { type: "if"; condition: FlowFormula; then: SourceFlowTask[]; else?: SourceFlowTask[] | undefined }
    | {
        type: "switch";
        value: FlowValue;
        cases: { key: string; when: FlowLiteral; tasks: SourceFlowTask[] }[];
        default?: SourceFlowTask[] | undefined;
      }
    | { type: "for_each"; items: FlowValue; maximumItems: number; tasks: SourceFlowTask[] }
    | { type: "sequential"; tasks: SourceFlowTask[] }
    | { type: "run_flow"; flowId: string; inputs: Record<string, FlowValue> }
    | { type: "stop"; outcome: string }
    | { type: "parallel"; branches: SourceFlowTask[][] }
    | { type: "wait_until"; until: FlowValue }
    | {
        type: "wait_for_person";
        formId: string;
        assignee: FlowValue;
        inputs: Record<string, FlowValue>;
      }
    | {
        type: string;
        version: string;
        properties: Record<string, FlowValue>;
        allowRefusal?: boolean | undefined;
      }
  );

const sourceTaskCommonShape = {
  id: builderKeySchema,
  description: descriptionSchema.optional(),
  retry: retryPolicySchema.optional(),
  timeout: flowTaskTimeoutSchema.optional(),
};

export const sourceFlowTaskSchema: z.ZodType<SourceFlowTask> = z.lazy(() => {
  const list = z.array(sourceFlowTaskSchema).min(1).max(flowMaximumTaskCount);
  const control = z.discriminatedUnion("type", [
    z
      .object({
        ...sourceTaskCommonShape,
        type: z.literal("if"),
        condition: flowFormulaSchema,
        then: list,
        else: list.optional(),
      })
      .strict(),
    z
      .object({
        ...sourceTaskCommonShape,
        type: z.literal("switch"),
        value: flowValueSchema,
        cases: z
          .array(z.object({ key: builderKeySchema, when: flowLiteralSchema, tasks: list }).strict())
          .min(1)
          .max(20),
        default: list.optional(),
      })
      .strict(),
    z
      .object({
        ...sourceTaskCommonShape,
        type: z.literal("for_each"),
        items: flowValueSchema,
        maximumItems: z.number().int().min(1),
        tasks: list,
      })
      .strict(),
    z.object({ ...sourceTaskCommonShape, type: z.literal("sequential"), tasks: list }).strict(),
    z
      .object({
        ...sourceTaskCommonShape,
        type: z.literal("run_flow"),
        flowId: flowAliasSchema,
        inputs: boundedRecord(flowValueSchema, 50),
      })
      .strict(),
    z
      .object({ ...sourceTaskCommonShape, type: z.literal("stop"), outcome: builderKeySchema })
      .strict(),
    z
      .object({
        ...sourceTaskCommonShape,
        type: z.literal("parallel"),
        branches: z.array(list).min(2).max(10),
      })
      .strict(),
    z
      .object({ ...sourceTaskCommonShape, type: z.literal("wait_until"), until: flowValueSchema })
      .strict(),
    z
      .object({
        ...sourceTaskCommonShape,
        type: z.literal("wait_for_person"),
        formId: flowAliasSchema,
        assignee: flowValueSchema,
        inputs: boundedRecord(flowValueSchema, 50),
      })
      .strict(),
  ]);
  const registered = z
    .object({
      ...sourceTaskCommonShape,
      type: flowRegisteredTaskTypeSchema,
      version: stableDefinitionReleaseVersionSchema,
      properties: boundedRecord(flowValueSchema, 50),
      allowRefusal: z.boolean().optional(),
    })
    .strict();
  return z.union([control, registered]);
});

// ─── The authored flow ───────────────────────────────────────────────────────────────────────

export const sourceFlowSchema = z
  .object({
    contractVersion: z.literal(flowContractVersion),
    /** The flow's owner alias; resolves, with `key`, to the one permanent flow identity. */
    id: flowAliasSchema,
    key: builderKeySchema,
    description: descriptionSchema.optional(),
    labels: boundedRecord(textSchema(100), 20).default({}),
    execution: flowExecutionKindSchema,
    runAs: sourceFlowRunAsSchema,
    invocationPermissionId: flowAliasSchema.optional(),
    inputs: boundedRecord(sourceInputDeclarationSchema, 100).default({}),
    variables: boundedRecord(sourceVariableDeclarationSchema, 100).default({}),
    triggers: z.array(sourceFlowTriggerSchema).max(10).default([]),
    tasks: z.array(sourceFlowTaskSchema).min(1).max(flowMaximumTaskCount),
    outputs: boundedRecord(sourceOutputDeclarationSchema, 50).default({}),
    errors: z.array(sourceFlowTaskSchema).max(flowMaximumTaskCount).default([]),
    finally: z.array(sourceFlowTaskSchema).max(flowMaximumTaskCount).default([]),
    retry: retryPolicySchema.optional(),
    timeout: flowTaskTimeoutSchema.optional(),
    concurrency: z
      .object({
        limit: z.number().int().min(1).max(100),
        behavior: z.enum(["queue", "cancel", "fail"]),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SourceFlow = z.infer<typeof sourceFlowSchema>;

/** The flows one module or application owns. Every flow has exactly one owner. */
export const sourceFlowCollectionSchema = z
  .array(sourceFlowSchema)
  .max(100)
  .superRefine((flows, context) => {
    const ids = new Set<string>();
    const keys = new Set<string>();
    flows.forEach((flow, index) => {
      if (ids.has(flow.id))
        context.addIssue({ code: "custom", path: [index, "id"], message: "Flow ids must be unique" });
      if (keys.has(flow.key))
        context.addIssue({ code: "custom", path: [index, "key"], message: "Flow keys must be unique" });
      ids.add(flow.id);
      keys.add(flow.key);
    });
  });
export type SourceFlowCollection = z.infer<typeof sourceFlowCollectionSchema>;

// ─── The compiled set ────────────────────────────────────────────────────────────────────────

/**
 * What compiling a definition's flows contributes to its release: the canonical flows, the
 * dependency manifest contribution and provenance. The manifest lists each other definition a flow
 * reaches exactly once, whichever flow or task reaches it; the exact release evidence for each
 * lives on the definition's resolved-dependency manifest, never on a flow or a task.
 */
export const flowDependencyManifestContributionSchema = z
  .object({
    definitionKeys: z
      .array(namespacedKeySchema)
      .max(1_000)
      .refine(
        (keys) => keys.every((key, index) => index === 0 || keys[index - 1]! < key),
        { message: "Dependency definition keys must be unique and in ascending order" },
      ),
  })
  .strict();
export type FlowDependencyManifestContribution = z.infer<
  typeof flowDependencyManifestContributionSchema
>;

export const compiledFlowSetSchema = z
  .object({
    /** In ascending permanent flow identity, so unchanged source always compiles identically. */
    flows: z.array(flowSchema).max(100),
    dependencyManifest: flowDependencyManifestContributionSchema,
    /** Paths begin with the flow's index in `flows` and, for the source path, in the source set. */
    provenance: z.array(definitionProvenanceEntrySchema),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.flows.map((flow) => flow.id);
    if (ids.some((id, index) => index > 0 && ids[index - 1]! >= id))
      context.addIssue({
        code: "custom",
        path: ["flows"],
        message: "Compiled flows must be unique and in ascending permanent identity order",
      });
  });
export type CompiledFlowSet = z.infer<typeof compiledFlowSetSchema>;
