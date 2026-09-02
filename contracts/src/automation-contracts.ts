import { z } from "zod";
import { workflowNodeTypeKeys } from "./catalogues";
import { duplicateProtectionKeySchema, jsonValueSchema, retryPolicySchema } from "./common";
import {
  activityIdSchema,
  actorIdSchema,
  builderKeySchema,
  containedComponentIdSchema,
  fieldIdSchema,
  namespacedKeySchema,
  organizationIdSchema,
  applicationRootIdSchema,
  platformIdSchema,
  queryIdSchema,
  recordTypeIdSchema,
  pageIdSchema,
  revisionSchema,
  semanticVersionSchema,
  tenantIdSchema,
  timestampSchema,
  workflowIdSchema,
  workflowNodeIdSchema,
  workflowRunIdSchema,
} from "./identifiers";
import { conditionNodeSchema } from "./module-contracts";

export const workflowValueSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("literal"), value: jsonValueSchema }).strict(),
  z.object({ source: z.literal("trigger_field"), fieldId: fieldIdSchema }).strict(),
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
      values: z.record(fieldIdSchema, workflowValueSchema),
    })
    .strict(),
  change_record: z
    .object({
      recordTypeId: recordTypeIdSchema,
      record: workflowValueSchema,
      values: z.record(fieldIdSchema, workflowValueSchema),
    })
    .strict(),
  run_action: z
    .object({
      actionKey: namespacedKeySchema,
      subject: workflowValueSchema,
      inputs: z.record(builderKeySchema, workflowValueSchema),
    })
    .strict(),
  soft_delete_record: z
    .object({ recordTypeId: recordTypeIdSchema, record: workflowValueSchema })
    .strict(),
  duplicate_record: z
    .object({ recordTypeId: recordTypeIdSchema, record: workflowValueSchema })
    .strict(),
  add_relationship: z
    .object({
      relationshipId: containedComponentIdSchema,
      subject: workflowValueSchema,
      target: workflowValueSchema,
    })
    .strict(),
  copy_relationships: z
    .object({
      relationshipIds: z.array(containedComponentIdSchema).min(1),
      sourceRecord: workflowValueSchema,
      targetRecord: workflowValueSchema,
    })
    .strict(),
  request_form: z
    .object({
      pageId: pageIdSchema,
      responderPermissionKey: namespacedKeySchema,
      dueInSeconds: z.number().int().min(1).max(7_776_000),
      timeoutOutcome: builderKeySchema,
      outputKeys: z.array(builderKeySchema).min(1),
    })
    .strict(),
  query_records: z.object({ queryId: queryIdSchema }).strict(),
  set_values: z
    .object({ record: workflowValueSchema, values: z.record(fieldIdSchema, workflowValueSchema) })
    .strict(),
  format_value: z.object({ formatterKey: builderKeySchema, input: workflowValueSchema }).strict(),
  generate_export: z
    .object({ queryId: queryIdSchema, maximumRows: z.number().int().min(1).max(100_000) })
    .strict(),
  attach_file: z
    .object({ record: workflowValueSchema, fieldId: fieldIdSchema, file: workflowValueSchema })
    .strict(),
  move_file: z
    .object({ record: workflowValueSchema, fieldId: fieldIdSchema, file: workflowValueSchema })
    .strict(),
  call_connection: z
    .object({
      connectionBindingId: containedComponentIdSchema,
      operationKey: builderKeySchema,
      inputs: z.record(builderKeySchema, workflowValueSchema),
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

const workflowNodeMembers = workflowNodeTypeKeys.map((type) =>
  z.object({ ...commonNode, type: z.literal(type), config: nodeConfigByType[type] }).strict(),
);
export const workflowNodeSchema = z.discriminatedUnion(
  "type",
  workflowNodeMembers as [
    (typeof workflowNodeMembers)[number],
    (typeof workflowNodeMembers)[number],
    ...(typeof workflowNodeMembers)[number][],
  ],
);
export const workflowEdgeSchema = z
  .object({
    fromNodeId: workflowNodeIdSchema,
    toNodeId: workflowNodeIdSchema,
    outcome: builderKeySchema.optional(),
  })
  .strict();
export const workflowTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event"), eventKey: namespacedKeySchema }).strict(),
  z.object({ kind: z.literal("schedule"), scheduleKey: builderKeySchema }).strict(),
  z.object({ kind: z.literal("incoming_message"), messageKey: builderKeySchema }).strict(),
  z.object({ kind: z.literal("button"), actionKey: namespacedKeySchema }).strict(),
  z.object({ kind: z.literal("interface"), operationKey: builderKeySchema }).strict(),
  z.object({ kind: z.literal("workflow"), workflowId: workflowIdSchema }).strict(),
]);
export const workflowDefinitionSchema = z
  .object({
    workflowId: workflowIdSchema,
    key: builderKeySchema,
    name: z.string().min(1).max(120),
    trigger: workflowTriggerSchema,
    runAs: z.enum(["initiating_person", "system_with_source_authority"]),
    nodes: z.array(workflowNodeSchema).min(1).max(100),
    edges: z.array(workflowEdgeSchema),
    maximumNestingDepth: z.number().int().min(1).max(5),
  })
  .strict();

export const workflowExecutionReferenceSchema = z
  .object({
    runId: workflowRunIdSchema,
    tenantId: tenantIdSchema,
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationVersion: semanticVersionSchema,
    workflowId: workflowIdSchema,
    workflowRevision: revisionSchema,
    triggerKind: builderKeySchema,
    sourceId: platformIdSchema,
    startedBy: actorIdSchema,
    duplicateProtectionKey: duplicateProtectionKeySchema,
    humanInputIds: z.array(platformIdSchema),
    activityIds: z.array(activityIdSchema),
    lastRefreshedAt: timestampSchema,
    lastKnownState: z.enum(["queued", "running", "waiting", "completed", "cancelled", "failed"]),
  })
  .strict();
export const protectedOperationRequestSchema = z
  .object({
    contractVersion: semanticVersionSchema,
    runId: workflowRunIdSchema,
    nodeId: workflowNodeIdSchema,
    attempt: z.number().int().positive(),
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    workflowRevision: revisionSchema,
    operationKey: namespacedKeySchema,
    inputs: z.record(builderKeySchema, jsonValueSchema),
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    duplicateProtectionKey: duplicateProtectionKeySchema,
    signedCallerProof: z.string().min(32).max(10_000),
  })
  .strict();
export const protectedOperationResponseSchema = z
  .object({
    outcome: z.enum([
      "completed",
      "already_completed",
      "waiting",
      "retryable_failure",
      "permanent_refusal",
    ]),
    safeCode: builderKeySchema,
    nextPollAt: timestampSchema.optional(),
  })
  .strict();

export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;
export type WorkflowTrigger = z.infer<typeof workflowTriggerSchema>;
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowValue = z.infer<typeof workflowValueSchema>;
export type WorkflowExecutionReference = z.infer<typeof workflowExecutionReferenceSchema>;
export type ProtectedOperationRequest = z.infer<typeof protectedOperationRequestSchema>;
export type ProtectedOperationResponse = z.infer<typeof protectedOperationResponseSchema>;
