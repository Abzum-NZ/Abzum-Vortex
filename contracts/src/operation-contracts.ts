import { z } from "zod";
import {
  correlationIdSchema,
  duplicateProtectionKeySchema,
  jsonValueSchema,
  secretReferenceSchema,
} from "./common";
import { lifecycleStateSchema } from "./catalogues";
import {
  actionIdSchema,
  activityIdSchema,
  actorIdSchema,
  applicationRootIdSchema,
  builderKeySchema,
  containedComponentIdSchema,
  eventIdSchema,
  eventOccurrenceIdSchema,
  fieldIdSchema,
  fileIdSchema,
  fingerprintSchema,
  groupIdSchema,
  identityIdSchema,
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
import { installedEventDescriptorSchema } from "./module-contracts";
import type { StandardInstalledEventKind } from "./module-contracts";

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

const javascriptSafeEventRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);

const eventOccurrenceDefinitionReleaseV2Schema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("application"),
      rootId: applicationRootIdSchema,
      releaseRevision: javascriptSafeEventRevisionSchema,
      releaseVersion: semanticVersionSchema,
      contentFingerprint: fingerprintSchema,
      resolutionFingerprint: fingerprintSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("module"),
      rootId: moduleRootIdSchema,
      releaseRevision: javascriptSafeEventRevisionSchema,
      releaseVersion: semanticVersionSchema,
      contentFingerprint: fingerprintSchema,
      resolutionFingerprint: fingerprintSchema,
    })
    .strict(),
]);

const canonicalFieldIdsSchema = z
  .array(fieldIdSchema)
  .min(1)
  .max(500)
  .superRefine((fieldIds, context) => {
    if (new Set(fieldIds).size !== fieldIds.length)
      context.addIssue({ code: "custom", message: "Field identities must be unique" });
    if (fieldIds.some((fieldId, index) => index > 0 && fieldIds[index - 1]! >= fieldId))
      context.addIssue({ code: "custom", message: "Field identities must use canonical order" });
  });

const emptyStandardOccurrencePayload = (
  kind: Exclude<StandardInstalledEventKind, "changed" | "state_changed">,
) => z.object({ kind: z.literal(kind) }).strict();

const standardEventOccurrencePayloadV2Schema = z.discriminatedUnion("kind", [
  emptyStandardOccurrencePayload("created"),
  z.object({ kind: z.literal("changed"), changedFieldIds: canonicalFieldIdsSchema }).strict(),
  emptyStandardOccurrencePayload("deleted"),
  emptyStandardOccurrencePayload("linked"),
  emptyStandardOccurrencePayload("unlinked"),
  emptyStandardOccurrencePayload("reassigned"),
  z
    .object({
      kind: z.literal("state_changed"),
      fieldId: fieldIdSchema,
      previousValue: jsonValueSchema.optional(),
      newValue: jsonValueSchema.optional(),
    })
    .strict(),
]);

const declaredEventOccurrencePayloadV2Schema = z
  .object({ kind: z.literal("declared"), carriedValues: z.record(fieldIdSchema, jsonValueSchema) })
  .strict();

/**
 * Versioned occurrence data. It preserves the historical V1 envelope and keeps
 * the occurrence identity distinct from the reusable declaration identity.
 * Definition-backed payload privacy and field-type checks are intentionally
 * performed by Event using Record's field semantics, not claimed by this shape alone.
 */
export const eventOccurrenceEnvelopeV2Schema = z
  .object({
    contractVersion: z.literal("2.0.0"),
    occurrenceId: eventOccurrenceIdSchema,
    organizationId: organizationIdSchema,
    installation: z
      .object({
        applicationRootId: applicationRootIdSchema,
        applicationReleaseRevision: javascriptSafeEventRevisionSchema,
        moduleBinding: z
          .object({
            moduleRootId: moduleRootIdSchema,
            moduleReleaseRevision: javascriptSafeEventRevisionSchema,
            bindingRevision: javascriptSafeEventRevisionSchema,
          })
          .strict(),
      })
      .strict(),
    descriptor: installedEventDescriptorSchema,
    definitionRelease: eventOccurrenceDefinitionReleaseV2Schema,
    recordId: recordIdSchema,
    occurredAt: timestampSchema,
    actorId: actorIdSchema,
    correlationId: correlationIdSchema,
    causationId: platformIdSchema.optional(),
    recordSequence: javascriptSafeEventRevisionSchema,
    payload: z.union([
      standardEventOccurrencePayloadV2Schema,
      declaredEventOccurrencePayloadV2Schema,
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedPayloadKind =
      value.descriptor.kind === "standard" ? value.descriptor.eventKind : "declared";
    if (value.payload.kind !== expectedPayloadKind)
      context.addIssue({
        code: "custom",
        path: ["payload", "kind"],
        message: "Occurrence payload kind must match its installed event descriptor",
      });
    if (value.descriptor.kind === "declared") {
      const ownerRootId =
        value.descriptor.owner.kind === "application"
          ? value.descriptor.owner.applicationRootId
          : value.descriptor.owner.moduleRootId;
      if (
        value.definitionRelease.kind !== value.descriptor.owner.kind ||
        value.definitionRelease.rootId !== ownerRootId
      )
        context.addIssue({
          code: "custom",
          path: ["definitionRelease"],
          message: "Declared occurrence release must match its declaration owner",
        });
      if (
        (value.descriptor.owner.kind === "application" &&
          value.installation.applicationRootId !== value.descriptor.owner.applicationRootId) ||
        (value.descriptor.owner.kind === "module" &&
          value.installation.moduleBinding.moduleRootId !== value.descriptor.owner.moduleRootId)
      )
        context.addIssue({
          code: "custom",
          path: ["installation"],
          message: "Declared occurrence installation must contain its declaration owner",
        });
    } else if (
      value.definitionRelease.kind !== "module" ||
      value.definitionRelease.rootId !== value.installation.moduleBinding.moduleRootId
    )
      context.addIssue({
        code: "custom",
        path: ["definitionRelease"],
        message: "A standard occurrence belongs to its record type's Module release",
      });
  });
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

export const fileLifecycleStateSchema = z.enum([
  "pending",
  "uploaded",
  "scanning",
  "active",
  "quarantined",
  "abandoned",
  "soft_deleted",
  "removed",
]);

/**
 * Verified file actor. A private file is attributed either to a verified human
 * organisation account with its global identity, or to a registered system
 * actor. A system operation never fabricates an organisation account.
 */
export const verifiedFileActorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("human"),
      organizationAccountId: organizationAccountIdSchema,
      identityId: identityIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("system"),
      systemActorId: actorIdSchema,
    })
    .strict(),
]);

/** Business files live only in the private bucket; published public assets are a separate variant. */
export const PRIVATE_FILE_BUCKET = "private_files";
export const privateFileBucketSchema = z.literal(PRIVATE_FILE_BUCKET);

/** A private object path is `<organizationId>/<fileId>/<128 bits of hexadecimal entropy>`. */
const privateFilePathSegment =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
export const privateFileObjectPathSchema = z
  .string()
  .max(1_000)
  .regex(
    new RegExp(`^${privateFilePathSegment}/${privateFilePathSegment}/[0-9a-f]{32}$`),
    "A private object path is organisation-scoped, unguessable and never carries the original file name",
  );

export const fileStorageOperationSchema = z.enum(["upload", "read", "delete"]);

/** The Storage credential bridge mints operation claims valid for at most 60 seconds. */
export const MAXIMUM_FILE_STORAGE_OPERATION_SECONDS = 60;

export const fileStorageOperationClaimsSchema = z
  .object({
    role: z.literal("authenticated"),
    aud: z.literal("authenticated"),
    iss: z.string().min(1).max(255),
    tokenKind: z.literal("vortex_file_storage_operation"),
    destinationProject: z.string().min(1).max(120),
    organizationId: organizationIdSchema,
    bucketId: privateFileBucketSchema,
    objectPath: privateFileObjectPathSchema,
    operation: fileStorageOperationSchema,
    actor: verifiedFileActorSchema,
    correlationId: correlationIdSchema,
    iat: z.number().int().positive(),
    exp: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.exp <= value.iat)
      context.addIssue({
        code: "custom",
        path: ["exp"],
        message: "A storage operation credential must expire after it is issued",
      });
    else if (value.exp - value.iat > MAXIMUM_FILE_STORAGE_OPERATION_SECONDS)
      context.addIssue({
        code: "custom",
        path: ["exp"],
        message: `A storage operation credential is valid for at most ${MAXIMUM_FILE_STORAGE_OPERATION_SECONDS} seconds`,
      });
    if (!value.objectPath.startsWith(`${value.organizationId}/`))
      context.addIssue({
        code: "custom",
        path: ["objectPath"],
        message: "A storage operation credential scopes its object path to its own organisation",
      });
  });

/**
 * Non-authoritative legal-hold projection for display or query purposes only.
 * A boolean flag or display projection confers no removal authority; file removal
 * eligibility must be authoritatively evaluated by the resolver-backed File service
 * against active protected organisation legal holds and retention policies.
 */
export const fileLegalHoldProjectionSchema = z
  .object({
    isHeld: z.boolean(),
  })
  .strict();
export type FileLegalHoldProjection = z.infer<typeof fileLegalHoldProjectionSchema>;

/**
 * Versioned scope of a protected legal hold under Specification 14.
 * A legal hold protects only data matching its authorised, versioned scope.
 */
export const protectedLegalHoldScopeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("all_organization_data"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file"),
      fileId: fileIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("record"),
      recordTypeId: recordTypeIdSchema,
      recordId: recordIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("record_type"),
      recordTypeId: recordTypeIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("application"),
      applicationRootId: applicationRootIdSchema,
    })
    .strict(),
]);
export type ProtectedLegalHoldScope = z.infer<typeof protectedLegalHoldScopeSchema>;

/**
 * Exact protected legal hold reference binding organisation ownership, hold identity,
 * lifecycle status and versioned scope.
 */
export const protectedLegalHoldReferenceSchema = z
  .object({
    tenantId: tenantIdSchema,
    holdId: platformIdSchema,
    organizationId: organizationIdSchema,
    scope: protectedLegalHoldScopeSchema,
    status: z.enum(["active", "released"]),
    holdRevision: revisionSchema,
    scopeRevision: revisionSchema,
  })
  .strict();
export type ProtectedLegalHoldReference = z.infer<typeof protectedLegalHoldReferenceSchema>;

export const fileRemovalOwnerBindingSchema = z
  .object({
    sourceOrganizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema.optional(),
    recordTypeId: recordTypeIdSchema,
    recordId: recordIdSchema,
    fieldId: fieldIdSchema,
    recordRevision: revisionSchema,
  })
  .strict();
export type FileRemovalOwnerBinding = z.infer<typeof fileRemovalOwnerBindingSchema>;

export const activeFileAttachmentReferenceSchema = z
  .object({
    referenceId: platformIdSchema,
    sourceOrganizationId: organizationIdSchema,
    fileId: fileIdSchema,
    owner: fileRemovalOwnerBindingSchema,
  })
  .strict();
export type ActiveFileAttachmentReference = z.infer<
  typeof activeFileAttachmentReferenceSchema
>;

export const activeFileShareReferenceSchema = z
  .object({
    referenceId: platformIdSchema,
    sourceOrganizationId: organizationIdSchema,
    recipientOrganizationId: organizationIdSchema,
    fileId: fileIdSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.sourceOrganizationId.toLowerCase() !==
      value.recipientOrganizationId.toLowerCase(),
    {
      path: ["recipientOrganizationId"],
      message: "A file share names a distinct recipient organisation",
    },
  );
export type ActiveFileShareReference = z.infer<typeof activeFileShareReferenceSchema>;

export const activeFileSourceResponsibilityReferenceSchema = z
  .object({
    referenceId: platformIdSchema,
    sourceOrganizationId: organizationIdSchema,
    fileId: fileIdSchema,
  })
  .strict();
export type ActiveFileSourceResponsibilityReference = z.infer<
  typeof activeFileSourceResponsibilityReferenceSchema
>;

export const fileRemovalRecoveryPolicySnapshotSchema = z
  .object({
    tenantId: tenantIdSchema,
    organizationId: organizationIdSchema,
    sourceOrganizationId: organizationIdSchema,
    retentionPolicyId: retentionPolicyIdSchema,
    policyRevision: revisionSchema,
    applicationRootId: applicationRootIdSchema.optional(),
    recordTypeId: recordTypeIdSchema.optional(),
    recoveryDeadline: timestampSchema,
    resolvedAt: timestampSchema,
    validUntil: timestampSchema,
  })
  .strict();
export type FileRemovalRecoveryPolicySnapshot = z.infer<
  typeof fileRemovalRecoveryPolicySnapshotSchema
>;

export const fileRemovalHoldAuthoritySnapshotSchema = z
  .object({
    tenantId: tenantIdSchema,
    organizationId: organizationIdSchema,
    policyRevision: revisionSchema,
    resolvedAt: timestampSchema,
    validUntil: timestampSchema,
  })
  .strict();
export type FileRemovalHoldAuthoritySnapshot = z.infer<
  typeof fileRemovalHoldAuthoritySnapshotSchema
>;

/**
 * Closed stable refusal reasons for file removal eligibility.
 * No reason contains protected content, provider details, hold identifiers or
 * foreign organisation identifiers.
 */
export const fileRemovalRefusalReasonSchema = z.enum([
  "authority_unavailable",
  "authority_stale",
  "ownership_mismatch",
  "wrong_lifecycle",
  "current_recovery_protection",
  "matching_legal_hold",
  "active_attachment_ownership",
  "active_share_responsibility",
  "active_source_responsibility",
  "stale_revision",
  "unavailable_governing_policy",
  "malformed_input",
]);
export type FileRemovalRefusalReason = z.infer<typeof fileRemovalRefusalReasonSchema>;

/** The public request selects a file; it carries no eligibility or policy facts. */
export const fileRemovalEligibilityRequestSchema = z
  .object({
    fileId: fileIdSchema,
  })
  .strict();
export type FileRemovalEligibilityRequest = z.infer<
  typeof fileRemovalEligibilityRequestSchema
>;

/**
 * Complete current-authority snapshot returned by trusted File-service wiring.
 * It is never accepted from a credential request. The exact object, owner and
 * revisions are repeated deliberately so stale or mixed resolver projections
 * fail closed before a delete credential can be signed.
 */
export const fileRemovalAuthoritySnapshotSchema = z
  .object({
    tenantId: tenantIdSchema,
    organizationId: organizationIdSchema,
    sourceOrganizationId: organizationIdSchema,
    fileId: fileIdSchema,
    bucketId: privateFileBucketSchema,
    objectPath: privateFileObjectPathSchema,
    applicationRootId: applicationRootIdSchema.optional(),
    fileRevision: revisionSchema,
    lifecycleState: fileLifecycleStateSchema,
    owner: fileRemovalOwnerBindingSchema.nullable(),
    governingPolicyId: retentionPolicyIdSchema,
    governingPolicyRevision: revisionSchema,
    expectedFileRevision: revisionSchema,
    expectedRecordRevision: revisionSchema.nullable(),
    activeAttachmentReferences: z.array(activeFileAttachmentReferenceSchema),
    activeShareReferences: z.array(activeFileShareReferenceSchema),
    activeSourceResponsibilityReferences: z.array(
      activeFileSourceResponsibilityReferenceSchema,
    ),
    holds: z.array(protectedLegalHoldReferenceSchema),
    holdAuthority: fileRemovalHoldAuthoritySnapshotSchema.nullable(),
    recoveryPolicy: fileRemovalRecoveryPolicySnapshotSchema.nullable(),
    resolvedAt: timestampSchema,
    validUntil: timestampSchema,
  })
  .strict();
export type FileRemovalAuthoritySnapshot = z.infer<
  typeof fileRemovalAuthoritySnapshotSchema
>;

export const fileRemovalEligibilityBindingSchema = z
  .object({
    authorityFingerprint: fingerprintSchema,
    fileRevision: revisionSchema,
    recordRevision: revisionSchema.nullable(),
    governingPolicyRevision: revisionSchema,
    holdPolicyRevision: revisionSchema,
  })
  .strict();
export type FileRemovalEligibilityBinding = z.infer<
  typeof fileRemovalEligibilityBindingSchema
>;

export const fileRemovalEligibleDecisionSchema = z
  .object({
    eligible: z.literal(true),
    status: z.literal("eligible"),
    reason: z.null(),
    binding: fileRemovalEligibilityBindingSchema,
    decidedAt: timestampSchema,
  })
  .strict();
export type FileRemovalEligibleDecision = z.infer<typeof fileRemovalEligibleDecisionSchema>;

export const fileRemovalRefusedDecisionSchema = z
  .object({
    eligible: z.literal(false),
    status: z.literal("refused"),
    reason: fileRemovalRefusalReasonSchema,
    decidedAt: timestampSchema,
  })
  .strict();
export type FileRemovalRefusedDecision = z.infer<typeof fileRemovalRefusedDecisionSchema>;

export const fileRemovalEligibilityDecisionSchema = z.discriminatedUnion("eligible", [
  fileRemovalEligibleDecisionSchema,
  fileRemovalRefusedDecisionSchema,
]);
export type FileRemovalEligibilityDecision = z.infer<typeof fileRemovalEligibilityDecisionSchema>;

/**
 * Canonical stages of file object and metadata removal under Specifications 11 and 14.
 * Previews and active derived copies are cleaned, the private storage object is
 * deleted, and the file metadata is transitioned to its terminal tombstone.
 */
export const fileRemovalStageSchema = z.enum([
  "previews",
  "storage_object",
  "metadata",
]);
export type FileRemovalStage = z.infer<typeof fileRemovalStageSchema>;

/**
 * Safe request to coordinate permanent file object removal.
 * Requires an eligible #657 decision and a stable deletion key; carries no
 * private storage paths or credentials, and the service re-evaluates the
 * submitted decision before accepting a new intent.
 */
export const fileObjectRemovalRequestSchema = z
  .object({
    fileId: fileIdSchema,
    deletionKey: duplicateProtectionKeySchema,
    decision: fileRemovalEligibleDecisionSchema,
    correlationId: correlationIdSchema,
  })
  .strict();
export type FileObjectRemovalRequest = z.infer<typeof fileObjectRemovalRequestSchema>;

/**
 * Resumable partial state for an interrupted or in-progress file removal.
 * Accurately identifies completed and current stages without exposing private
 * storage paths or content.
 */
export const fileObjectRemovalPartialStateSchema = z
  .object({
    fileId: fileIdSchema,
    organizationId: organizationIdSchema,
    deletionKey: duplicateProtectionKeySchema,
    status: z.enum(["in_progress", "interrupted"]),
    completedStages: z.array(fileRemovalStageSchema),
    currentStage: fileRemovalStageSchema,
    authorityFingerprint: fingerprintSchema,
    startedAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const stages = fileRemovalStageSchema.options;
    const currentIndex = stages.indexOf(value.currentStage);
    const expectedCompleted = stages.slice(0, currentIndex);
    if (
      value.completedStages.length !== expectedCompleted.length ||
      value.completedStages.some((stage, index) => stage !== expectedCompleted[index])
    )
      context.addIssue({
        code: "custom",
        path: ["completedStages"],
        message: "Completed removal stages must be the canonical prefix before the current stage",
      });
  });
export type FileObjectRemovalPartialState = z.infer<
  typeof fileObjectRemovalPartialStateSchema
>;

/**
 * Content-free terminal receipt for completed permanent file removal.
 * Emitted only when all owned stages (previews, storage object, metadata tombstone)
 * are complete. Converges idempotently on repeated calls with the same deletion key.
 */
export const fileObjectRemovalReceiptSchema = z
  .object({
    receiptId: platformIdSchema,
    fileId: fileIdSchema,
    organizationId: organizationIdSchema,
    deletionKey: duplicateProtectionKeySchema,
    status: z.literal("completed"),
    outcome: z.literal("removed"),
    completedStages: z.array(fileRemovalStageSchema),
    authorityFingerprint: fingerprintSchema,
    removedAt: timestampSchema,
    completedAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const stages = fileRemovalStageSchema.options;
    if (
      value.completedStages.length !== stages.length ||
      value.completedStages.some((stage, index) => stage !== stages[index])
    )
      context.addIssue({
        code: "custom",
        path: ["completedStages"],
        message: "A terminal removal receipt records every stage once in canonical order",
      });
    if (value.completedAt !== value.removedAt)
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "The terminal receipt commits at the same instant as the file tombstone",
      });
  });
export type FileObjectRemovalReceipt = z.infer<
  typeof fileObjectRemovalReceiptSchema
>;

export const fileRecordSchema = z
  .object({
    fileId: fileIdSchema,
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema.optional(),
    lifecycleState: fileLifecycleStateSchema,
    originalSafeDisplayName: z.string().min(1).max(255),
    detectedMediaType: z.string().min(1).max(200),
    extension: z.string().regex(/^\.[a-z0-9]+$/),
    sizeBytes: z.number().int().min(0),
    checksum: fingerprintSchema,
    storageKey: privateFileObjectPathSchema,
    bucketId: privateFileBucketSchema,
    scannerName: z.string().min(1).max(120),
    scannerVersion: z.string().min(1).max(120),
    scannerResult: z.enum(["pending", "clean", "quarantined", "refused"]),
    previewReferences: z.array(secretReferenceSchema),
    uploadedBy: verifiedFileActorSchema,
    createdAt: timestampSchema,
    activatedAt: timestampSchema.optional(),
    deletedAt: timestampSchema.optional(),
    removalDueAt: timestampSchema.optional(),
    removedAt: timestampSchema.optional(),
    owningAttachmentReferences: z.array(platformIdSchema),
    ownerRecordTypeId: recordTypeIdSchema.optional(),
    ownerRecordId: recordIdSchema.optional(),
    ownerFieldId: fieldIdSchema.optional(),
    legalHold: fileLegalHoldProjectionSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.storageKey.startsWith(`${value.organizationId}/${value.fileId}/`))
      context.addIssue({
        code: "custom",
        path: ["storageKey"],
        message:
          "A private file object path is scoped to its own organisation and file identifier",
      });

    const ownerParts = [value.ownerRecordTypeId, value.ownerRecordId, value.ownerFieldId];
    if (
      ownerParts.some((part) => part !== undefined) &&
      ownerParts.some((part) => part === undefined)
    )
      context.addIssue({
        code: "custom",
        path: ["ownerFieldId"],
        message: "Owner record type, record and attachment field travel together or not at all",
      });

    if (value.lifecycleState === "active") {
      if (value.scannerResult !== "clean")
        context.addIssue({
          code: "custom",
          path: ["scannerResult"],
          message: "A file becomes active only after its safety check passes",
        });
      if (value.activatedAt === undefined)
        context.addIssue({
          code: "custom",
          path: ["activatedAt"],
          message: "An active file records when it was activated",
        });
      if (value.deletedAt !== undefined)
        context.addIssue({
          code: "custom",
          path: ["deletedAt"],
          message: "An active file carries no deletion time",
        });
    }

    if (
      value.lifecycleState === "quarantined" &&
      value.scannerResult !== "quarantined" &&
      value.scannerResult !== "refused"
    )
      context.addIssue({
        code: "custom",
        path: ["scannerResult"],
        message: "A quarantined file records the safety result that quarantined it",
      });

    if (value.lifecycleState === "soft_deleted" && value.deletedAt === undefined)
      context.addIssue({
        code: "custom",
        path: ["deletedAt"],
        message: "A soft-deleted file records when it was deleted",
      });

    if (value.lifecycleState === "removed") {
      if (value.removedAt === undefined)
        context.addIssue({
          code: "custom",
          path: ["removedAt"],
          message: "A permanently removed file records when removal completed",
        });
      if (value.previewReferences.length !== 0)
        context.addIssue({
          code: "custom",
          path: ["previewReferences"],
          message: "A permanently removed file retains no preview references",
        });
      if (value.owningAttachmentReferences.length !== 0)
        context.addIssue({
          code: "custom",
          path: ["owningAttachmentReferences"],
          message: "A permanently removed file retains no active attachment references",
        });
      if (
        value.deletedAt !== undefined &&
        value.removedAt !== undefined &&
        Date.parse(value.removedAt) < Date.parse(value.deletedAt)
      )
        context.addIssue({
          code: "custom",
          path: ["removedAt"],
          message: "Permanent removal cannot predate soft deletion",
        });
    } else if (value.removedAt !== undefined)
      context.addIssue({
        code: "custom",
        path: ["removedAt"],
        message: "Only a permanently removed file carries a removal time",
      });
  });

const transferGrantBase = {
  organizationId: organizationIdSchema,
  actor: verifiedFileActorSchema,
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

const canonicalActivitySubjectIdsSchema = z
  .array(platformIdSchema)
  .min(1)
  .superRefine((identifiers, context) => {
    const canonicalIdentifiers = identifiers.map((identifier) => identifier.toLowerCase());
    for (let index = 1; index < canonicalIdentifiers.length; index += 1) {
      if (canonicalIdentifiers[index - 1]! >= canonicalIdentifiers[index]!) {
        context.addIssue({
          code: "custom",
          message: "Activity subject identifiers must be unique and in canonical order",
        });
        return;
      }
    }
  });

const canonicalActivityChangedFieldIdsSchema = z
  .array(fieldIdSchema)
  .superRefine((identifiers, context) => {
    const canonicalIdentifiers = identifiers.map((identifier) => identifier.toLowerCase());
    for (let index = 1; index < canonicalIdentifiers.length; index += 1) {
      if (canonicalIdentifiers[index - 1]! >= canonicalIdentifiers[index]!) {
        context.addIssue({
          code: "custom",
          message: "Changed field identifiers must be unique and in canonical order",
        });
        return;
      }
    }
  });

export const activityActorKindSchema = z.enum([
  "identity",
  "organization_account",
  "system",
  "public_session",
]);

export const activityEntrySchema = z
  .object({
    organizationId: organizationIdSchema,
    activityId: activityIdSchema,
    occurredAt: timestampSchema,
    actorKind: activityActorKindSchema,
    actorId: actorIdSchema,
    action: builderKeySchema,
    subjectIds: canonicalActivitySubjectIdsSchema,
    changedFieldIds: canonicalActivityChangedFieldIdsSchema,
    source: z.enum(["web", "workflow", "interface", "connection", "federation", "system"]),
    correlationId: correlationIdSchema,
    outcome: z.enum(["completed", "refused", "failed"]),
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
export type EventOccurrenceEnvelopeV2 = z.infer<typeof eventOccurrenceEnvelopeV2Schema>;
export type EventDispatch = z.infer<typeof eventDispatchSchema>;
export type LiveInvalidation = z.infer<typeof liveInvalidationSchema>;
export type CacheInvalidation = z.infer<typeof cacheInvalidationSchema>;
export type OperationalStatus = z.infer<typeof operationalStatusSchema>;
export type ApplicationSideEffectReceipt = z.infer<typeof applicationSideEffectReceiptSchema>;
export type FileLifecycleState = z.infer<typeof fileLifecycleStateSchema>;
export type VerifiedFileActor = z.infer<typeof verifiedFileActorSchema>;
export type PrivateFileBucket = z.infer<typeof privateFileBucketSchema>;
export type FileStorageOperation = z.infer<typeof fileStorageOperationSchema>;
export type FileStorageOperationClaims = z.infer<typeof fileStorageOperationClaimsSchema>;
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
