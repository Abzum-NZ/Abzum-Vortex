import { z } from "zod";
import { workflowNodeTypeKeys } from "./catalogues";
import { duplicateProtectionKeySchema, jsonValueSchema, retryPolicySchema } from "./common";
import {
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
      values: z.record(fieldIdSchema, jsonValueSchema),
    })
    .strict(),
  change_record: z
    .object({
      recordTypeId: recordTypeIdSchema,
      values: z.record(fieldIdSchema, jsonValueSchema),
    })
    .strict(),
  run_action: z
    .object({ actionKey: namespacedKeySchema, inputs: z.record(builderKeySchema, jsonValueSchema) })
    .strict(),
  soft_delete_record: z.object({ recordTypeId: recordTypeIdSchema }).strict(),
  duplicate_record: z.object({ recordTypeId: recordTypeIdSchema }).strict(),
  convert_record: z
    .object({
      fromRecordTypeId: recordTypeIdSchema,
      toRecordTypeId: recordTypeIdSchema,
      mappingId: containedComponentIdSchema,
    })
    .strict(),
  add_relationship: z.object({ relationshipId: containedComponentIdSchema }).strict(),
  copy_relationships: z
    .object({ relationshipIds: z.array(containedComponentIdSchema).min(1) })
    .strict(),
  add_comment: z
    .object({ visibility: z.enum(["internal", "public"]), text: z.string().min(1).max(10_000) })
    .strict(),
  change_tags: z
    .object({ add: z.array(builderKeySchema), remove: z.array(builderKeySchema) })
    .strict(),
  request_form: z.object({ pageId: pageIdSchema }).strict(),
  request_approval: z.object({ reasonCode: builderKeySchema }).strict(),
  create_task: z.object({ subject: z.string().min(1).max(200) }).strict(),
  create_calendar_event: z
    .object({ connectionBindingId: containedComponentIdSchema, operationKey: builderKeySchema })
    .strict(),
  notification: z.object({ audienceKey: builderKeySchema, messageKey: builderKeySchema }).strict(),
  send_email: z
    .object({
      connectionBindingId: containedComponentIdSchema,
      operationKey: builderKeySchema,
      templateKey: builderKeySchema.optional(),
    })
    .strict(),
  query_records: z.object({ queryId: queryIdSchema }).strict(),
  set_values: z.object({ values: z.record(fieldIdSchema, jsonValueSchema) }).strict(),
  format_value: z.object({ formatterKey: builderKeySchema, input: jsonValueSchema }).strict(),
  generate_export: z
    .object({ queryId: queryIdSchema, maximumRows: z.number().int().min(1).max(100_000) })
    .strict(),
  attach_file: z.object({ fieldId: fieldIdSchema }).strict(),
  move_file: z.object({ fieldId: fieldIdSchema }).strict(),
  generate_document: z.object({ templateKey: builderKeySchema }).strict(),
  call_connection: z
    .object({ connectionBindingId: containedComponentIdSchema, operationKey: builderKeySchema })
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
    kestraExecutionId: z.string().min(1).max(200),
    kestraNamespace: z.string().min(1).max(200),
    triggerKind: builderKeySchema,
    sourceId: platformIdSchema,
    startedBy: platformIdSchema,
    duplicateProtectionKey: duplicateProtectionKeySchema,
    humanTaskIds: z.array(platformIdSchema),
    activityIds: z.array(platformIdSchema),
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
export type WorkflowExecutionReference = z.infer<typeof workflowExecutionReferenceSchema>;
export type ProtectedOperationRequest = z.infer<typeof protectedOperationRequestSchema>;
export type ProtectedOperationResponse = z.infer<typeof protectedOperationResponseSchema>;
