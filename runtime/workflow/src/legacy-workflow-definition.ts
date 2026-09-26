import {
  builderKeySchema,
  conditionNodeSchema,
  containedComponentIdSchema,
  fieldIdSchema,
  jsonValueSchema,
  namespacedKeySchema,
  pageIdSchema,
  queryIdSchema,
  recordTypeIdSchema,
  retryPolicySchema,
  workflowIdSchema,
  workflowNodeIdSchema,
  workflowNodeTypeKeys,
  workflowRunAsSchema,
  workflowValueTypeSchema,
} from "@vortex/contracts";
import { z } from "zod";

/**
 * The node-and-edge durable workflow shape that `kestra-compiler.ts` still reads.
 *
 * Issue #1086 removed `workflowDefinitionSchema` from `@vortex/contracts`, where the one flow
 * contract (`flowSchema`, `durable` execution) now owns durable workflows. The Kestra compiler is
 * rewritten against durable flows by #1087, so this file keeps only the legacy shape the current
 * compiler needs until then. Nothing else may import it, and #1087 deletes it together with the
 * compiler's node-and-edge branch.
 */
export const legacyWorkflowNodeTypeKeys = workflowNodeTypeKeys;

const isRecordReferenceType = (type: string) =>
  type === "record_reference" || type === "record_reference_list";

const legacyWorkflowDeclaredOutputSchema = z
  .object({
    key: builderKeySchema,
    type: workflowValueTypeSchema,
    recordTypeIds: z.array(recordTypeIdSchema).min(1).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (isRecordReferenceType(value.type) !== (value.recordTypeIds !== undefined))
      context.addIssue({
        code: "custom",
        path: ["recordTypeIds"],
        message: "Record-reference and record-list outputs require their allowed record types",
      });
  });

export const legacyWorkflowValueSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("literal"), value: jsonValueSchema }).strict(),
  z.object({ source: z.literal("trigger_field"), fieldId: fieldIdSchema }).strict(),
  z.object({ source: z.literal("trigger_input"), inputKey: builderKeySchema }).strict(),
  z
    .object({
      source: z.literal("node_output"),
      nodeId: workflowNodeIdSchema,
      outputKey: builderKeySchema,
    })
    .strict(),
  z.object({ source: z.literal("current_record") }).strict(),
  z.object({ source: z.literal("current_actor") }).strict(),
  z.object({ source: z.literal("current_time") }).strict(),
]);

const nodeConfigByType = {
  start: z.object({}).strict(),
  condition: z.object({ condition: conditionNodeSchema }).strict(),
  decision_table: z
    .object({
      decisions: z
        .array(z.object({ when: conditionNodeSchema, output: builderKeySchema }).strict())
        .min(2),
    })
    .strict(),
  bounded_loop: z
    .object({ queryId: queryIdSchema, maximumRecords: z.number().int().min(1).max(1_000) })
    .strict(),
  delay: z.object({ seconds: z.number().int().min(1).max(7_776_000) }).strict(),
  wait_until: z.object({ dateTimeFieldId: fieldIdSchema }).strict(),
  start_workflow: z.object({ workflowId: workflowIdSchema }).strict(),
  stop: z.object({ reasonCode: builderKeySchema }).strict(),
  create_record: z
    .object({
      recordTypeId: recordTypeIdSchema,
      values: z.record(fieldIdSchema, legacyWorkflowValueSchema),
    })
    .strict(),
  change_record: z
    .object({
      recordTypeId: recordTypeIdSchema,
      record: legacyWorkflowValueSchema,
      values: z.record(fieldIdSchema, legacyWorkflowValueSchema),
    })
    .strict(),
  run_action: z
    .object({
      actionKey: namespacedKeySchema,
      subject: legacyWorkflowValueSchema,
      inputs: z.record(builderKeySchema, legacyWorkflowValueSchema),
    })
    .strict(),
  soft_delete_record: z
    .object({ recordTypeId: recordTypeIdSchema, record: legacyWorkflowValueSchema })
    .strict(),
  duplicate_record: z
    .object({ recordTypeId: recordTypeIdSchema, record: legacyWorkflowValueSchema })
    .strict(),
  add_relationship: z
    .object({
      relationshipId: containedComponentIdSchema,
      subject: legacyWorkflowValueSchema,
      target: legacyWorkflowValueSchema,
    })
    .strict(),
  copy_relationships: z
    .object({
      relationshipIds: z.array(containedComponentIdSchema).min(1),
      sourceRecord: legacyWorkflowValueSchema,
      targetRecord: legacyWorkflowValueSchema,
    })
    .strict(),
  request_form: z
    .object({
      pageId: pageIdSchema,
      responderPermissionKey: namespacedKeySchema,
      dueInSeconds: z.number().int().min(1).max(7_776_000),
      timeoutOutcome: builderKeySchema,
      outputs: z.array(legacyWorkflowDeclaredOutputSchema).min(1),
    })
    .strict(),
  query_records: z.object({ queryId: queryIdSchema }).strict(),
  set_values: z
    .object({
      record: legacyWorkflowValueSchema,
      values: z.record(fieldIdSchema, legacyWorkflowValueSchema),
    })
    .strict(),
  format_value: z
    .object({ formatterKey: builderKeySchema, input: legacyWorkflowValueSchema })
    .strict(),
  generate_export: z
    .object({ queryId: queryIdSchema, maximumRows: z.number().int().min(1).max(100_000) })
    .strict(),
  attach_file: z
    .object({
      record: legacyWorkflowValueSchema,
      fieldId: fieldIdSchema,
      file: legacyWorkflowValueSchema,
    })
    .strict(),
  move_file: z
    .object({
      record: legacyWorkflowValueSchema,
      fieldId: fieldIdSchema,
      file: legacyWorkflowValueSchema,
    })
    .strict(),
  call_connection: z
    .object({
      connectionBindingId: containedComponentIdSchema,
      operationKey: builderKeySchema,
      inputs: z.record(builderKeySchema, legacyWorkflowValueSchema),
    })
    .strict(),
  acknowledge_message: z.object({ messageKey: builderKeySchema }).strict(),
} satisfies Record<(typeof workflowNodeTypeKeys)[number], z.ZodType>;

const commonNode = {
  nodeId: workflowNodeIdSchema,
  permissionKey: namespacedKeySchema.optional(),
  timeoutSeconds: z.number().int().min(1).max(7_776_000),
  retry: retryPolicySchema,
  duplicateProtection: z.enum(["not_applicable", "required"]),
  activityKey: builderKeySchema,
  redaction: z.enum(["identifiers_only", "safe_fields", "no_payload"]),
};

const legacyWorkflowNodeMembers = workflowNodeTypeKeys.map((type) =>
  z.object({ ...commonNode, type: z.literal(type), config: nodeConfigByType[type] }).strict(),
);
export const legacyWorkflowNodeSchema = z.discriminatedUnion(
  "type",
  legacyWorkflowNodeMembers as [
    (typeof legacyWorkflowNodeMembers)[number],
    (typeof legacyWorkflowNodeMembers)[number],
    ...(typeof legacyWorkflowNodeMembers)[number][],
  ],
);
export const legacyWorkflowEdgeSchema = z
  .object({
    fromNodeId: workflowNodeIdSchema,
    toNodeId: workflowNodeIdSchema,
    outcome: builderKeySchema.optional(),
  })
  .strict();
const requireTriggerInputRecordTypes = (
  value: { type: string; recordTypeIds?: unknown },
  context: z.RefinementCtx,
) => {
  if (isRecordReferenceType(value.type) !== (value.recordTypeIds !== undefined))
    context.addIssue({
      code: "custom",
      path: ["recordTypeIds"],
      message: "Record-reference and record-list inputs require their allowed record types",
    });
};
const legacyWorkflowTriggerInputSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("record_field"),
      key: builderKeySchema,
      type: workflowValueTypeSchema,
      fieldId: fieldIdSchema,
      recordTypeIds: z.array(recordTypeIdSchema).min(1).optional(),
    })
    .strict()
    .superRefine(requireTriggerInputRecordTypes),
  z
    .object({
      source: z.literal("payload"),
      key: builderKeySchema,
      type: workflowValueTypeSchema,
      payloadKey: builderKeySchema,
      recordTypeIds: z.array(recordTypeIdSchema).min(1).optional(),
    })
    .strict()
    .superRefine(requireTriggerInputRecordTypes),
]);
const legacyWorkflowTriggerCommon = {
  inputs: z.array(legacyWorkflowTriggerInputSchema).max(100),
  condition: conditionNodeSchema.nullable(),
  duplicateProtection: z.enum(["not_required", "required"]),
};
const legacyWorkflowScheduleSchema = z
  .object({
    cadence: z.enum(["hourly", "daily", "weekly", "monthly"]),
    interval: z.number().int().min(1).max(365),
    timeZone: z.string().min(1).max(100),
    minute: z.number().int().min(0).max(59),
    hour: z.number().int().min(0).max(23).optional(),
    weekDay: z.number().int().min(1).max(7).optional(),
    monthDay: z.number().int().min(1).max(31).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const valid =
      (value.cadence === "hourly" &&
        value.hour === undefined &&
        value.weekDay === undefined &&
        value.monthDay === undefined) ||
      (value.cadence === "daily" &&
        value.hour !== undefined &&
        value.weekDay === undefined &&
        value.monthDay === undefined) ||
      (value.cadence === "weekly" &&
        value.hour !== undefined &&
        value.weekDay !== undefined &&
        value.monthDay === undefined) ||
      (value.cadence === "monthly" &&
        value.hour !== undefined &&
        value.weekDay === undefined &&
        value.monthDay !== undefined);
    if (!valid)
      context.addIssue({
        code: "custom",
        path: ["cadence"],
        message: "Schedule fields must match cadence",
      });
  });
export const legacyWorkflowTriggerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("event"),
      eventKey: namespacedKeySchema,
      recordTypeId: recordTypeIdSchema,
      ...legacyWorkflowTriggerCommon,
    })
    .strict(),
  z
    .object({
      kind: z.literal("schedule"),
      schedule: legacyWorkflowScheduleSchema,
      ...legacyWorkflowTriggerCommon,
    })
    .strict(),
  z
    .object({
      kind: z.literal("incoming_message"),
      messageKey: builderKeySchema,
      ...legacyWorkflowTriggerCommon,
    })
    .strict(),
  z
    .object({ kind: z.literal("button"), actionKey: namespacedKeySchema, ...legacyWorkflowTriggerCommon })
    .strict(),
  z
    .object({
      kind: z.literal("interface"),
      operationKey: builderKeySchema,
      ...legacyWorkflowTriggerCommon,
    })
    .strict(),
  z
    .object({ kind: z.literal("workflow"), workflowId: workflowIdSchema, ...legacyWorkflowTriggerCommon })
    .strict(),
]);

export const legacyWorkflowDefinitionSchema = z
  .object({
    workflowId: workflowIdSchema,
    key: builderKeySchema,
    name: z.string().min(1).max(120),
    trigger: legacyWorkflowTriggerSchema,
    runAs: workflowRunAsSchema,
    nodes: z.array(legacyWorkflowNodeSchema).min(1).max(100),
    edges: z.array(legacyWorkflowEdgeSchema),
    maximumNestingDepth: z.number().int().min(1).max(5),
  })
  .strict();

export type WorkflowNode = z.infer<typeof legacyWorkflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof legacyWorkflowEdgeSchema>;
export type WorkflowTrigger = z.infer<typeof legacyWorkflowTriggerSchema>;
export type WorkflowDefinition = z.infer<typeof legacyWorkflowDefinitionSchema>;
export type WorkflowValue = z.infer<typeof legacyWorkflowValueSchema>;
