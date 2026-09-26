import { z } from "zod";
import { duplicateProtectionKeySchema, jsonValueSchema } from "./common";
import {
  activityIdSchema,
  actorIdSchema,
  builderKeySchema,
  fingerprintSchema,
  namespacedKeySchema,
  organizationIdSchema,
  applicationRootIdSchema,
  platformIdSchema,
  revisionSchema,
  semanticVersionSchema,
  stableDefinitionReleaseVersionSchema,
  tenantIdSchema,
  timestampSchema,
  workflowIdSchema,
  workflowNodeIdSchema,
  workflowRunIdSchema,
} from "./identifiers";


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
 * workflow-revision order. `kestraInstance` names the application Kestra
 * instance (#1152), the only provider a schedule change may target; the
 * operations instance cannot be expressed.
 */
export const installationWorkflowActivationEvidenceSchema = z
  .object({
    kestraInstance: z.literal("application"),
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
 * remain available to explain each outcome. Schedules are disabled only on the
 * application Kestra instance (#1152).
 */
export const installationWorkflowWithdrawalReconciliationSchema = z
  .object({
    kestraInstance: z.literal("application"),
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: revisionSchema,
    newAcceptance: z.literal("blocked"),
    schedulesToDisable: z.array(installationWorkflowFlowReferenceSchema).max(1_000),
    starts: z.array(installationWorkflowWithdrawalStartSchema).max(100_000),
  })
  .strict();

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
