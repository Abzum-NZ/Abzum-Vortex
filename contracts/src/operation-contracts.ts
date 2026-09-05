import { z } from "zod";
import { correlationIdSchema, jsonValueSchema, secretReferenceSchema } from "./common";
import { lifecycleStateSchema } from "./catalogues";
import {
  actionIdSchema,
  activityIdSchema,
  actorIdSchema,
  applicationRootIdSchema,
  builderKeySchema,
  containedComponentIdSchema,
  eventIdSchema,
  fieldIdSchema,
  fileIdSchema,
  fingerprintSchema,
  groupIdSchema,
  meteringEventIdSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  platformIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  removalReceiptIdSchema,
  retentionPolicyIdSchema,
  revisionSchema,
  semanticVersionSchema,
  storageContractIdSchema,
  tenantIdSchema,
  timestampSchema,
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
      z.object({ kind: z.literal("group"), groupId: groupIdSchema }).strict(),
    ])
    .optional(),
  lifecycleState: lifecycleStateSchema,
  concurrencyNumber: z.number().int().positive(),
  values: z.record(fieldIdSchema, jsonValueSchema),
  createdAt: timestampSchema,
  createdBy: actorIdSchema,
  updatedAt: timestampSchema,
  updatedBy: actorIdSchema,
  deletedAt: timestampSchema.optional(),
  deletedBy: actorIdSchema.optional(),
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
    applicationRootId: applicationRootIdSchema.optional(),
    moduleRootId: moduleRootIdSchema,
    recordTypeId: recordTypeIdSchema,
    recordId: recordIdSchema,
    eventName: builderKeySchema,
    occurredAt: timestampSchema,
    actorId: actorIdSchema,
    correlationId: correlationIdSchema,
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
    applicationRootId: applicationRootIdSchema,
    recordTypeId: recordTypeIdSchema,
    recordId: recordIdSchema.optional(),
    changeKind: z.enum(["created", "changed", "deleted", "restored", "access_changed"]),
    dataVersion: revisionSchema,
    recordVersion: revisionSchema.optional(),
    sequence: revisionSchema,
    occurredAt: timestampSchema,
    correlationId: correlationIdSchema,
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
    correlationId: correlationIdSchema,
  })
  .strict();
export const operationalStatusSchema = z
  .object({
    component: builderKeySchema,
    environment: z.enum(["local", "testing", "production"]),
    state: z.enum(["healthy", "degraded", "unavailable", "maintenance"]),
    observedAt: timestampSchema,
    safeCode: builderKeySchema,
    correlationId: correlationIdSchema.optional(),
  })
  .strict();
export const applicationSideEffectReceiptSchema = z
  .object({
    runId: workflowRunIdSchema,
    nodeId: workflowNodeIdSchema,
    attempt: z.number().int().positive(),
    duplicateProtectionKey: z.string().min(16).max(200),
    acceptedAt: timestampSchema,
    safeInputFingerprint: fingerprintSchema,
    outcome: z.enum(["completed", "already_completed", "refused", "failed"]),
    resultingRecordIds: z.array(recordIdSchema),
    resultingActionIds: z.array(actionIdSchema),
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
    actorId: actorIdSchema,
    action: builderKeySchema,
    subjectIds: z.array(platformIdSchema).min(1),
    changedFieldIds: z.array(fieldIdSchema),
    source: z.enum(["web", "workflow", "interface", "connection", "federation", "system"]),
    correlationId: correlationIdSchema,
    outcome: z.enum(["completed", "refused", "failed"]),
    retainedDetailReference: secretReferenceSchema.optional(),
  })
  .strict();
export const retentionPolicySchema = z
  .object({
    retentionPolicyId: retentionPolicyIdSchema,
    organizationId: organizationIdSchema,
    dataCategory: builderKeySchema,
    savedConditionId: containedComponentIdSchema.optional(),
    savedConditionRevision: revisionSchema.optional(),
    savedConditionFingerprint: fingerprintSchema.optional(),
    activeDays: z.number().int().min(0).max(36_500),
    recoveryDays: z.number().int().min(0).max(3_650),
    removalSchedule: z.string().min(1).max(200),
    legalConstraintKeys: z.array(builderKeySchema),
    state: z.enum(["draft", "active", "retired"]),
    createdBy: organizationAccountIdSchema,
    approvedBy: organizationAccountIdSchema,
    version: revisionSchema,
  })
  .strict()
  .refine(
    (value) => {
      const suppliedReferenceParts = [
        value.savedConditionId,
        value.savedConditionRevision,
        value.savedConditionFingerprint,
      ].filter((item) => item !== undefined).length;
      return suppliedReferenceParts === 0 || suppliedReferenceParts === 3;
    },
    {
      path: ["savedConditionId"],
      message: "A saved condition identifier, revision and fingerprint are supplied together",
    },
  );
export const permanentRemovalReceiptSchema = z
  .object({
    removalReceiptId: removalReceiptIdSchema,
    organizationId: organizationIdSchema,
    protectedFingerprint: fingerprintSchema,
    category: builderKeySchema,
    selectionFingerprint: fingerprintSchema,
    completedAt: timestampSchema,
    retentionPolicyId: retentionPolicyIdSchema,
    jobId: platformIdSchema,
    outcome: z.enum(["removed", "partially_removed", "lawful_exception"]),
    lawfulExceptionCode: builderKeySchema.optional(),
  })
  .strict();
export const protectedRemovalCommandSchema = z
  .object({
    commandId: platformIdSchema,
    tenantId: tenantIdSchema,
    organizationIds: z.array(organizationIdSchema).min(1),
    dataCategories: z.array(builderKeySchema).min(1),
    savedConditionId: containedComponentIdSchema.optional(),
    savedConditionRevision: revisionSchema.optional(),
    subjectFingerprint: fingerprintSchema.optional(),
    requestedBy: platformIdSchema,
    authorizedBy: platformIdSchema,
    issuedAt: timestampSchema,
    correlationId: correlationIdSchema,
  })
  .strict()
  .refine(
    (value) =>
      (value.savedConditionId === undefined) === (value.savedConditionRevision === undefined),
    {
      path: ["savedConditionRevision"],
      message: "A saved condition identifier and revision are supplied together",
    },
  );

export const entitlementCheckRequestSchema = z
  .object({
    tenantId: tenantIdSchema,
    organizationId: organizationIdSchema.optional(),
    capabilityKey: namespacedKeySchema,
    requestedQuantity: z.number().positive().finite(),
    unit: builderKeySchema,
    correlationId: correlationIdSchema,
  })
  .strict();
const entitlementDecisionCommon = {
  decisionId: platformIdSchema,
  tenantId: tenantIdSchema,
  organizationId: organizationIdSchema.optional(),
  capabilityKey: namespacedKeySchema,
  requestedQuantity: z.number().positive().finite(),
  unit: builderKeySchema,
  policyRevision: revisionSchema,
  decidedAt: timestampSchema,
  correlationId: correlationIdSchema,
};
export const entitlementDecisionSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      ...entitlementDecisionCommon,
      outcome: z.literal("allowed"),
      acceptedQuantity: z.number().positive().finite(),
      remainingQuantity: z.number().nonnegative().finite().optional(),
    })
    .strict()
    .refine((value) => value.acceptedQuantity <= value.requestedQuantity, {
      path: ["acceptedQuantity"],
      message: "An entitlement decision cannot accept more than was requested",
    }),
  z
    .object({
      ...entitlementDecisionCommon,
      outcome: z.literal("refused"),
      reasonCode: builderKeySchema,
    })
    .strict(),
]);
export const meteringEventSchema = z
  .object({
    meteringEventId: meteringEventIdSchema,
    tenantId: tenantIdSchema,
    organizationId: organizationIdSchema.optional(),
    capabilityKey: namespacedKeySchema,
    quantity: z.number().positive().finite(),
    unit: builderKeySchema,
    occurredAt: timestampSchema,
    sourceEventId: eventIdSchema.optional(),
    duplicateProtectionKey: z.string().min(16).max(200),
    correlationId: correlationIdSchema,
    acceptedAt: timestampSchema,
  })
  .strict();
export const safeOperationErrorCatalogue = Object.freeze({
  invalid_request: "errors.invalid_request",
  not_found: "errors.not_found",
  operation_refused: "errors.operation_refused",
  conflict: "errors.conflict",
  rate_limited: "errors.rate_limited",
  temporarily_unavailable: "errors.temporarily_unavailable",
  operation_failed: "errors.operation_failed",
} as const);

const safeErrorVariant = <Code extends keyof typeof safeOperationErrorCatalogue>(code: Code) =>
  z
    .object({
      code: z.literal(code),
      messageKey: z.literal(safeOperationErrorCatalogue[code]),
      correlationId: correlationIdSchema,
    })
    .strict();

export const safeErrorResponseSchema = z.discriminatedUnion("code", [
  safeErrorVariant("invalid_request"),
  safeErrorVariant("not_found"),
  safeErrorVariant("operation_refused"),
  safeErrorVariant("conflict"),
  safeErrorVariant("rate_limited"),
  safeErrorVariant("temporarily_unavailable"),
  safeErrorVariant("operation_failed"),
]);
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
export type ApplicationSideEffectReceipt = z.infer<typeof applicationSideEffectReceiptSchema>;
export type FileRecord = z.infer<typeof fileRecordSchema>;
export type UploadGrant = z.infer<typeof uploadGrantSchema>;
export type DownloadGrant = z.infer<typeof downloadGrantSchema>;
export type ActivityEntry = z.infer<typeof activityEntrySchema>;
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;
export type PermanentRemovalReceipt = z.infer<typeof permanentRemovalReceiptSchema>;
export type ProtectedRemovalCommand = z.infer<typeof protectedRemovalCommandSchema>;
export type EntitlementCheckRequest = z.infer<typeof entitlementCheckRequestSchema>;
export type EntitlementDecision = z.infer<typeof entitlementDecisionSchema>;
export type MeteringEvent = z.infer<typeof meteringEventSchema>;
export type SafeErrorResponse = z.infer<typeof safeErrorResponseSchema>;
export type PerformanceMeasurement = z.infer<typeof performanceMeasurementSchema>;
