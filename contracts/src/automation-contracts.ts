import { z } from "zod";
import { workflowNodeTypeKeys, workflowValueTypeSchema } from "./catalogues";
import { duplicateProtectionKeySchema, jsonValueSchema, retryPolicySchema } from "./common";
import {
  activityIdSchema,
  actorIdSchema,
  builderKeySchema,
  containedComponentIdSchema,
  fieldIdSchema,
  fingerprintSchema,
  namespacedKeySchema,
  organizationIdSchema,
  applicationRootIdSchema,
  platformIdSchema,
  queryIdSchema,
  recordTypeIdSchema,
  pageIdSchema,
  revisionSchema,
  semanticVersionSchema,
  stableDefinitionReleaseVersionSchema,
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

const isRecordReferenceType = (type: string) =>
  type === "record_reference" || type === "record_reference_list";

const workflowDeclaredOutputSchema = z
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
      outputs: z.array(workflowDeclaredOutputSchema).min(1),
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
const workflowTriggerInputSchema = z.discriminatedUnion("source", [
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
const workflowTriggerCommon = {
  inputs: z.array(workflowTriggerInputSchema).max(100),
  condition: conditionNodeSchema.nullable(),
  duplicateProtection: z.enum(["not_required", "required"]),
};
const workflowScheduleSchema = z
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
export const workflowTriggerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("event"),
      eventKey: namespacedKeySchema,
      recordTypeId: recordTypeIdSchema,
      ...workflowTriggerCommon,
    })
    .strict(),
  z
    .object({
      kind: z.literal("schedule"),
      schedule: workflowScheduleSchema,
      ...workflowTriggerCommon,
    })
    .strict(),
  z
    .object({
      kind: z.literal("incoming_message"),
      messageKey: builderKeySchema,
      ...workflowTriggerCommon,
    })
    .strict(),
  z
    .object({ kind: z.literal("button"), actionKey: namespacedKeySchema, ...workflowTriggerCommon })
    .strict(),
  z
    .object({
      kind: z.literal("interface"),
      operationKey: builderKeySchema,
      ...workflowTriggerCommon,
    })
    .strict(),
  z
    .object({ kind: z.literal("workflow"), workflowId: workflowIdSchema, ...workflowTriggerCommon })
    .strict(),
]);
/**
 * @deprecated The durable node-and-edge workflow is replaced by the one flow definition in
 * `flow-contracts.ts` (`durable` execution). Conversion and removal belong to #986 and #988; do not
 * extend this format.
 */
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

/**
 * #662: one exact inactive workflow flow registration named by installation
 * activation readiness evidence. It carries only permanent identity, the
 * generated provider identifiers and the stored candidate fingerprint; it never
 * carries the candidate's task bodies.
 */
export const installationWorkflowRegisteredFlowSchema = z
  .object({
    workflowRevision: revisionSchema,
    flowId: z.string().min(1).max(100),
    namespace: z.string().min(1).max(150),
    candidateFingerprint: fingerprintSchema,
    status: z.literal("inactive"),
    /** True only when the published trigger is a schedule; never guessed from a label. */
    scheduled: z.boolean(),
  })
  .strict();

/** #662: a registered flow named by a schedule reconciliation, without its diagnostic detail. */
export const installationWorkflowFlowReferenceSchema = z
  .object({
    workflowRevision: revisionSchema,
    flowId: z.string().min(1).max(100),
    namespace: z.string().min(1).max(150),
  })
  .strict();

/**
 * #662: the complete verified inactive flow set of one installation candidate.
 * `installationRevision` is the Application release revision that the #64
 * activation acts on, so readiness evidence and the activation target cannot
 * drift apart. Every workflow of the release appears exactly once in canonical
 * workflow-revision order.
 */
export const installationWorkflowActivationEvidenceSchema = z
  .object({
    environment: z.enum(["local", "testing", "production"]),
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationVersion: stableDefinitionReleaseVersionSchema,
    installationRevision: revisionSchema,
    flows: z.array(installationWorkflowRegisteredFlowSchema).max(1_000),
  })
  .strict()
  .superRefine((value, context) => {
    const revisions = value.flows.map((flow) => flow.workflowRevision);
    const flowIds = value.flows.map((flow) => flow.flowId);
    if (new Set(revisions).size !== revisions.length || new Set(flowIds).size !== flowIds.length)
      context.addIssue({
        code: "custom",
        path: ["flows"],
        message: "Each workflow appears exactly once",
      });
    if (revisions.some((revision, index) => index > 0 && revisions[index - 1]! >= revision))
      context.addIssue({
        code: "custom",
        path: ["flows"],
        message: "Registered flows must use canonical workflow-revision order",
      });
  });

/**
 * #662: why an installation candidate could not become ready. The reason is
 * stable reporting metadata: it never selects a flow or grants activation.
 */
export const installationWorkflowReadinessRefusalReasons = [
  "invalid_input",
  "duplicate_workflow",
  "identity_mismatch",
  "missing_registration",
  "refused_registration",
  "mismatched_registration",
] as const;

export const installationWorkflowReadinessRefusalReasonSchema = z.enum(
  installationWorkflowReadinessRefusalReasons,
);

export type InstallationWorkflowReadinessRefusalReason =
  (typeof installationWorkflowReadinessRefusalReasons)[number];

/** #662: the idempotent schedule reconciliation steps taken after activation or withdrawal. */
export const installationWorkflowScheduleActions = ["enable", "disable"] as const;

export const installationWorkflowScheduleActionSchema = z.enum(
  installationWorkflowScheduleActions,
);

export const installationWorkflowScheduleChangeSchema = z
  .object({
    workflowRevision: revisionSchema,
    flowId: z.string().min(1).max(100),
    namespace: z.string().min(1).max(150),
    action: installationWorkflowScheduleActionSchema,
  })
  .strict();

/**
 * #662: one accepted start retained through an ordinary upgrade, pinned to the
 * exact Application release and workflow revision it was accepted under. A newer
 * installation pointer never retargets it.
 */
export const installationWorkflowRetainedStartSchema = z
  .object({
    runId: workflowRunIdSchema,
    applicationReleaseRevision: revisionSchema,
    workflowRevision: revisionSchema,
  })
  .strict();

/**
 * #662: the ready or refused result of installation activation readiness. A
 * refusal is never activation evidence, so the previously active exact release
 * stays selected; a ready result additionally names the schedule reconciliation
 * and every accepted start the upgrade leaves pinned.
 */
export const installationWorkflowActivationPlanSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("ready"),
      evidence: installationWorkflowActivationEvidenceSchema,
      scheduleChanges: z.array(installationWorkflowScheduleChangeSchema).max(2_000),
      retainedStarts: z.array(installationWorkflowRetainedStartSchema).max(100_000),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("refused"),
      reason: installationWorkflowReadinessRefusalReasonSchema,
    })
    .strict(),
]);

/** #662: how one accepted start is settled when its installation is withdrawn. */
export const installationWorkflowWithdrawalDecisions = [
  "refused_before_start",
  "cancellation_requested",
] as const;

export const installationWorkflowWithdrawalDecisionSchema = z.enum(
  installationWorkflowWithdrawalDecisions,
);

/** #662: one accepted start retained by a withdrawal, pinned to its accepted revision. */
export const installationWorkflowWithdrawalStartSchema = z
  .object({
    runId: workflowRunIdSchema,
    applicationReleaseRevision: revisionSchema,
    workflowRevision: revisionSchema,
    decision: installationWorkflowWithdrawalDecisionSchema,
  })
  .strict();

/**
 * #662: the reconciliation a withdrawal records. New acceptance, including every
 * scheduled wake-up, is blocked; the withdrawn release's schedules are disabled;
 * and every accepted start is retained with an explicit refusal or cancellation
 * request rather than discarded. Execution, mapping, intent and activity history
 * remain available to explain each outcome.
 */
export const installationWorkflowWithdrawalReconciliationSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: revisionSchema,
    newAcceptance: z.literal("blocked"),
    schedulesToDisable: z.array(installationWorkflowFlowReferenceSchema).max(1_000),
    starts: z.array(installationWorkflowWithdrawalStartSchema).max(100_000),
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
export type InstallationWorkflowRegisteredFlow = z.infer<
  typeof installationWorkflowRegisteredFlowSchema
>;
export type InstallationWorkflowFlowReference = z.infer<
  typeof installationWorkflowFlowReferenceSchema
>;
export type InstallationWorkflowActivationEvidence = z.infer<
  typeof installationWorkflowActivationEvidenceSchema
>;
export type InstallationWorkflowScheduleAction = z.infer<
  typeof installationWorkflowScheduleActionSchema
>;
export type InstallationWorkflowScheduleChange = z.infer<
  typeof installationWorkflowScheduleChangeSchema
>;
export type InstallationWorkflowRetainedStart = z.infer<
  typeof installationWorkflowRetainedStartSchema
>;
export type InstallationWorkflowActivationPlan = z.infer<
  typeof installationWorkflowActivationPlanSchema
>;
export type InstallationWorkflowWithdrawalDecision = z.infer<
  typeof installationWorkflowWithdrawalDecisionSchema
>;
export type InstallationWorkflowWithdrawalStart = z.infer<
  typeof installationWorkflowWithdrawalStartSchema
>;
export type InstallationWorkflowWithdrawalReconciliation = z.infer<
  typeof installationWorkflowWithdrawalReconciliationSchema
>;
