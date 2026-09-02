import { z } from "zod";
import { jsonValueSchema, safeHttpsUrlSchema, secretReferenceSchema } from "./common";
import { lifecycleStateSchema } from "./catalogues";
import {
  activityIdSchema,
  announcementIdSchema,
  applicationRootIdSchema,
  builderKeySchema,
  eventIdSchema,
  fieldIdSchema,
  fileIdSchema,
  fingerprintSchema,
  moduleRootIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  planIdSchema,
  platformIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  removalReceiptIdSchema,
  retentionPolicyIdSchema,
  revisionSchema,
  semanticVersionSchema,
  storageContractIdSchema,
  subscriptionIdSchema,
  teamIdSchema,
  tenantIdSchema,
  timestampSchema,
  usageEntryIdSchema,
  workflowNodeIdSchema,
  workflowRunIdSchema,
} from "./identifiers";

const businessRecordFields = {
  organizationId: organizationIdSchema,
  moduleRootId: moduleRootIdSchema,
  recordTypeId: recordTypeIdSchema,
  storageContractId: storageContractIdSchema,
  recordId: recordIdSchema,
  definitionRevision: revisionSchema,
  owner: z
    .discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("organization_account"),
          organizationAccountId: organizationAccountIdSchema,
        })
        .strict(),
      z.object({ kind: z.literal("team"), teamId: teamIdSchema }).strict(),
    ])
    .optional(),
  lifecycleState: lifecycleStateSchema,
  concurrencyNumber: z.number().int().positive(),
  values: z.record(fieldIdSchema, jsonValueSchema),
  createdAt: timestampSchema,
  createdBy: platformIdSchema,
  updatedAt: timestampSchema,
  updatedBy: platformIdSchema,
  deletedAt: timestampSchema.optional(),
  deletedBy: platformIdSchema.optional(),
  removalDueAt: timestampSchema.optional(),
};
const organizationSharedBusinessRecordSchema = z
  .object({ storageScope: z.literal("organization_shared"), ...businessRecordFields })
  .strict();
const applicationContainedBusinessRecordSchema = z
  .object({
    storageScope: z.literal("application_contained"),
    ...businessRecordFields,
    applicationRootId: applicationRootIdSchema,
  })
  .strict();
export const businessRecordSchema = z
  .discriminatedUnion("storageScope", [
    organizationSharedBusinessRecordSchema,
    applicationContainedBusinessRecordSchema,
  ])
  .superRefine((value, context) => {
    const deleted = value.lifecycleState !== "active";
    if (deleted !== (value.deletedAt !== undefined && value.deletedBy !== undefined))
      context.addIssue({
        code: "custom",
        path: ["deletedAt"],
        message: "Deletion evidence is present exactly after soft deletion",
      });
    if ((value.lifecycleState === "removal_pending") !== (value.removalDueAt !== undefined))
      context.addIssue({
        code: "custom",
        path: ["removalDueAt"],
        message: "A removal due time is present exactly while removal is pending",
      });
  });
export const eventEnvelopeSchema = z
  .object({
    eventId: eventIdSchema,
    organizationId: organizationIdSchema,
    applicationRootId: platformIdSchema.optional(),
    moduleRootId: platformIdSchema,
    recordTypeId: recordTypeIdSchema,
    recordId: recordIdSchema,
    eventName: builderKeySchema,
    occurredAt: timestampSchema,
    actorId: platformIdSchema,
    correlationId: platformIdSchema,
    causationId: platformIdSchema.optional(),
    definitionRevisions: z.record(z.string(), revisionSchema),
    recordSequence: revisionSchema,
    carriedValues: z.record(fieldIdSchema, jsonValueSchema),
  })
  .strict();
export const eventDispatchSchema = z
  .object({
    eventId: eventIdSchema,
    status: z.enum(["pending", "claimed", "delivered", "failed"]),
    availableAt: timestampSchema,
    claimOwner: z.string().min(1).max(200).optional(),
    claimExpiresAt: timestampSchema.optional(),
    attempts: z.number().int().min(0).max(100),
    lastSafeErrorCode: builderKeySchema.optional(),
    deliveredAt: timestampSchema.optional(),
    failedSequenceResolution: z.enum(["retry", "skip", "stop"]).optional(),
  })
  .strict();
export const liveInvalidationSchema = z
  .object({
    contractVersion: semanticVersionSchema,
    organizationId: organizationIdSchema,
    applicationRootId: platformIdSchema,
    recordTypeId: recordTypeIdSchema,
    recordId: recordIdSchema.optional(),
    changeKind: z.enum(["created", "changed", "deleted", "restored", "access_changed"]),
    dataVersion: revisionSchema,
    recordVersion: revisionSchema.optional(),
    sequence: revisionSchema,
    occurredAt: timestampSchema,
    correlationId: platformIdSchema,
  })
  .strict();
export const cacheInvalidationSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema.optional(),
    subjectKind: z.enum(["access", "definition", "record_type", "record", "query"]),
    subjectId: platformIdSchema,
    version: revisionSchema,
    occurredAt: timestampSchema,
    correlationId: platformIdSchema,
  })
  .strict();
export const operationalStatusSchema = z
  .object({
    component: builderKeySchema,
    environment: z.enum(["local", "testing", "production"]),
    state: z.enum(["healthy", "degraded", "unavailable", "maintenance"]),
    observedAt: timestampSchema,
    safeCode: builderKeySchema,
    correlationId: platformIdSchema.optional(),
  })
  .strict();
export const businessSideEffectReceiptSchema = z
  .object({
    runId: workflowRunIdSchema,
    nodeId: workflowNodeIdSchema,
    attempt: z.number().int().positive(),
    duplicateProtectionKey: z.string().min(16).max(200),
    acceptedAt: timestampSchema,
    safeInputFingerprint: fingerprintSchema,
    outcome: z.enum(["completed", "already_completed", "refused", "failed"]),
    resultingRecordIds: z.array(recordIdSchema),
    resultingActionIds: z.array(platformIdSchema),
    resultingEventIds: z.array(eventIdSchema),
  })
  .strict();

export const fileRecordSchema = z
  .object({
    fileId: fileIdSchema,
    organizationId: organizationIdSchema,
    lifecycleState: lifecycleStateSchema,
    originalSafeDisplayName: z.string().min(1).max(255),
    detectedMediaType: z.string().min(1).max(200),
    extension: z.string().regex(/^\.[a-z0-9]+$/),
    sizeBytes: z.number().int().min(0),
    checksum: fingerprintSchema,
    storageKey: z.string().min(1).max(1_000),
    scannerName: z.string().min(1).max(120),
    scannerVersion: z.string().min(1).max(120),
    scannerResult: z.enum(["pending", "clean", "quarantined", "refused"]),
    previewReferences: z.array(secretReferenceSchema),
    uploadedBy: organizationAccountIdSchema,
    createdAt: timestampSchema,
    activatedAt: timestampSchema.optional(),
    deletedAt: timestampSchema.optional(),
    removalDueAt: timestampSchema.optional(),
    owningAttachmentReferences: z.array(platformIdSchema),
    legalHold: z.boolean(),
  })
  .strict();
const transferGrantBase = {
  organizationId: organizationIdSchema,
  organizationAccountId: organizationAccountIdSchema,
  recordTypeId: recordTypeIdSchema,
  recordId: recordIdSchema,
  fieldId: fieldIdSchema,
  expiresAt: timestampSchema,
};
export const uploadGrantSchema = z
  .object({
    ...transferGrantBase,
    kind: z.literal("upload"),
    policyFingerprint: fingerprintSchema,
    maximumBytes: z.number().int().positive(),
    oneTimeId: platformIdSchema,
  })
  .strict();
export const downloadGrantSchema = z
  .object({
    ...transferGrantBase,
    kind: z.literal("download"),
    fileId: fileIdSchema,
    oneTimeId: platformIdSchema,
  })
  .strict();

export const activityEntrySchema = z
  .object({
    organizationId: organizationIdSchema,
    activityId: activityIdSchema,
    occurredAt: timestampSchema,
    actorId: platformIdSchema,
    action: builderKeySchema,
    subjectIds: z.array(platformIdSchema).min(1),
    changedFieldIds: z.array(fieldIdSchema),
    source: z.enum(["web", "workflow", "interface", "connection", "federation", "system"]),
    correlationId: platformIdSchema,
    outcome: z.enum(["completed", "refused", "failed"]),
    retainedDetailReference: secretReferenceSchema.optional(),
  })
  .strict();
export const retentionPolicySchema = z
  .object({
    retentionPolicyId: retentionPolicyIdSchema,
    organizationId: organizationIdSchema,
    dataCategory: builderKeySchema,
    selectionRule: z.record(z.string(), jsonValueSchema),
    activeDays: z.number().int().min(0).max(36_500),
    recoveryDays: z.number().int().min(0).max(3_650),
    removalSchedule: z.string().min(1).max(200),
    legalBounds: z.string().min(1).max(1_000),
    state: z.enum(["draft", "active", "retired"]),
    createdBy: organizationAccountIdSchema,
    approvedBy: organizationAccountIdSchema,
    version: revisionSchema,
  })
  .strict();
export const permanentRemovalReceiptSchema = z
  .object({
    removalReceiptId: removalReceiptIdSchema,
    organizationId: organizationIdSchema,
    protectedFingerprint: fingerprintSchema,
    category: builderKeySchema,
    scope: z.record(z.string(), jsonValueSchema),
    completedAt: timestampSchema,
    retentionPolicyId: retentionPolicyIdSchema,
    jobId: platformIdSchema,
    outcome: z.enum(["removed", "partially_removed", "lawful_exception"]),
    lawfulExceptionCode: builderKeySchema.optional(),
  })
  .strict();
export const privacyRequestSchema = z
  .object({
    requestId: platformIdSchema,
    kind: z.enum(["organization_scoped", "global_identity_closure", "tenant_batch"]),
    requesterIdentityId: platformIdSchema,
    organizationIds: z.array(organizationIdSchema).min(1),
    criteria: z.record(z.string(), jsonValueSchema),
    status: z.enum([
      "received",
      "verified",
      "working",
      "completed",
      "partially_completed",
      "refused",
    ]),
    findingReferences: z.array(secretReferenceSchema),
    approvalIds: z.array(platformIdSchema),
    completedAt: timestampSchema.optional(),
    removalReceiptIds: z.array(removalReceiptIdSchema),
  })
  .strict();

export const planVersionSchema = z
  .object({
    planId: planIdSchema,
    version: semanticVersionSchema,
    price: z.number().nonnegative(),
    currency: z.string().length(3),
    billingInterval: z.enum(["month", "year"]),
    entitlements: z.record(builderKeySchema, z.boolean()),
    measuredLimits: z.record(builderKeySchema, z.number().nonnegative()),
    warningThresholds: z.array(z.number().min(0).max(1)),
    overageRules: z.record(builderKeySchema, z.enum(["warn", "measure", "contact_tenant_admin"])),
    graceDays: z.number().int().min(0).max(365),
    trialRetentionDays: z.number().int().min(0).max(3_650),
    cancellationRetentionDays: z.number().int().min(0).max(3_650),
    effectiveAt: timestampSchema,
    publishedBy: platformIdSchema,
  })
  .strict();
export const tenantSubscriptionSchema = z
  .object({
    subscriptionId: subscriptionIdSchema,
    tenantId: tenantIdSchema,
    planId: planIdSchema,
    planVersion: semanticVersionSchema,
    stripeCustomerReference: z.string().min(1).max(200),
    stripeSubscriptionReference: z.string().min(1).max(200),
    state: z.enum([
      "trial",
      "active",
      "past_due",
      "grace_period",
      "cancelled_at_period_end",
      "cancelled",
      "administratively_suspended",
    ]),
    periodStartsAt: timestampSchema,
    periodEndsAt: timestampSchema,
    graceEndsAt: timestampSchema.optional(),
    entitlementFingerprint: fingerprintSchema,
    lastReconciledProviderEvent: z.string().min(1).max(200),
  })
  .strict();
export const usageEntrySchema = z
  .object({
    usageEntryId: usageEntryIdSchema,
    tenantId: tenantIdSchema,
    organizationId: organizationIdSchema,
    category: builderKeySchema,
    quantity: z.number().finite(),
    unit: builderKeySchema,
    windowStartsAt: timestampSchema,
    windowEndsAt: timestampSchema,
    sourceEventId: eventIdSchema,
    duplicateProtectionKey: z.string().min(16).max(200),
    correlationId: platformIdSchema,
    acceptedAt: timestampSchema,
    correctionOfUsageEntryId: usageEntryIdSchema.optional(),
  })
  .strict();
export const seatSnapshotSchema = z
  .object({
    tenantId: tenantIdSchema,
    capturedAt: timestampSchema,
    activeSeatCount: z.number().int().nonnegative(),
    contributingOrganizationAccountIds: z.array(organizationAccountIdSchema),
    sourceFingerprint: fingerprintSchema,
  })
  .strict()
  .refine(
    (value) => value.activeSeatCount === new Set(value.contributingOrganizationAccountIds).size,
    {
      path: ["activeSeatCount"],
      message: "Seat count must equal the unique contributing accounts",
    },
  );

export const announcementSchema = z
  .object({
    announcementId: announcementIdSchema,
    publisherKind: z.enum(["platform", "tenant", "organization", "application"]),
    publisherId: platformIdSchema,
    audienceScope: z.enum(["platform", "tenant", "organization", "application"]),
    audienceId: platformIdSchema.optional(),
    type: z.enum(["information", "warning", "critical"]),
    message: z.string().min(1).max(1_000),
    approvedLink: safeHttpsUrlSchema.optional(),
    startsAt: timestampSchema,
    endsAt: timestampSchema,
    dismissible: z.boolean(),
    state: z.enum(["draft", "published", "withdrawn", "ended"]),
    createdBy: platformIdSchema,
    publishedBy: platformIdSchema.optional(),
    activityId: activityIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.audienceScope === "platform") === (value.audienceId !== undefined))
      context.addIssue({
        code: "custom",
        path: ["audienceId"],
        message: "Only a non-platform audience has an audience identifier",
      });
  });
export const announcementDismissalSchema = z
  .object({
    announcementId: announcementIdSchema,
    organizationAccountId: organizationAccountIdSchema,
    dismissedAt: timestampSchema,
  })
  .strict();
export const safeErrorResponseSchema = z
  .object({
    code: builderKeySchema,
    message: z.string().min(1).max(1_000),
    correlationId: platformIdSchema,
    path: z.array(z.union([z.string(), z.number().int().nonnegative()])).optional(),
  })
  .strict();
export const performanceMeasurementSchema = z
  .object({
    operation: builderKeySchema,
    dataset: builderKeySchema,
    cacheState: z.enum(["cold", "warm", "bypass"]),
    region: z.string().min(1).max(100),
    device: z.string().min(1).max(100),
    network: z.string().min(1).max(100),
    percentile: z.enum(["p50", "p75", "p95", "p99"]),
    clientMilliseconds: z.number().nonnegative(),
    serverMilliseconds: z.number().nonnegative(),
    databaseMilliseconds: z.number().nonnegative(),
    codeRevision: z.string().min(7).max(64),
    comparisonBaseline: z.string().min(1).max(200),
  })
  .strict();

export type BusinessRecord = z.infer<typeof businessRecordSchema>;
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type EventDispatch = z.infer<typeof eventDispatchSchema>;
export type LiveInvalidation = z.infer<typeof liveInvalidationSchema>;
export type CacheInvalidation = z.infer<typeof cacheInvalidationSchema>;
export type OperationalStatus = z.infer<typeof operationalStatusSchema>;
export type BusinessSideEffectReceipt = z.infer<typeof businessSideEffectReceiptSchema>;
export type FileRecord = z.infer<typeof fileRecordSchema>;
export type UploadGrant = z.infer<typeof uploadGrantSchema>;
export type DownloadGrant = z.infer<typeof downloadGrantSchema>;
export type ActivityEntry = z.infer<typeof activityEntrySchema>;
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;
export type PermanentRemovalReceipt = z.infer<typeof permanentRemovalReceiptSchema>;
export type PrivacyRequest = z.infer<typeof privacyRequestSchema>;
export type PlanVersion = z.infer<typeof planVersionSchema>;
export type TenantSubscription = z.infer<typeof tenantSubscriptionSchema>;
export type UsageEntry = z.infer<typeof usageEntrySchema>;
export type SeatSnapshot = z.infer<typeof seatSnapshotSchema>;
export type Announcement = z.infer<typeof announcementSchema>;
export type AnnouncementDismissal = z.infer<typeof announcementDismissalSchema>;
export type SafeErrorResponse = z.infer<typeof safeErrorResponseSchema>;
export type PerformanceMeasurement = z.infer<typeof performanceMeasurementSchema>;
