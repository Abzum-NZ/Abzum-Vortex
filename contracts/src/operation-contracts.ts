import { z } from "zod";
import {
  correlationIdSchema,
  duplicateProtectionKeySchema,
  jsonValueSchema,
  secretReferenceSchema,
} from "./common";
import {
  actorIdSchema,
  applicationRootIdSchema,
  builderKeySchema,
  eventIdSchema,
  eventOccurrenceIdSchema,
  fieldIdSchema,
  fileIdSchema,
  fingerprintSchema,
  identityIdSchema,
  meteringEventIdSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  platformIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  retentionPolicyIdSchema,
  revisionSchema,
  semanticVersionSchema,
  tenantIdSchema,
  timestampSchema,
} from "./identifiers";
import { installedEventDescriptorSchema } from "./module-contracts";
import type { StandardInstalledEventKind } from "./module-contracts";

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

/**
 * The result of trusted server-side inspection of the stored object's bytes: its
 * actual size, the media type and canonical extension detected from its content,
 * and its checksum. Only the File service's inspector produces this; a file name,
 * browser-supplied type or client-reported size never substitutes for it.
 */
export const trustedFileInspectionSchema = z
  .object({
    actualSizeBytes: z.number().int().min(0),
    detectedMediaType: z.string().min(1).max(200),
    detectedExtension: z.string().regex(/^\.[a-z0-9]+$/),
    checksum: fingerprintSchema,
  })
  .strict();
export type TrustedFileInspection = z.infer<typeof trustedFileInspectionSchema>;

/** The outcome of the isolated safety scanner for one uploaded object. */
export const fileUploadScanOutcomeSchema = z
  .object({
    scannerName: z.string().min(1).max(120),
    scannerVersion: z.string().min(1).max(120),
    scannerResult: z.enum(["clean", "quarantined", "refused"]),
  })
  .strict();
export type FileUploadScanOutcome = z.infer<typeof fileUploadScanOutcomeSchema>;

export const fileUploadAdmissionRefusalReasonSchema = z.enum([
  "caller_not_authorized",
  "field_not_writable",
  "field_capacity_exceeded",
  "file_size_exceeded",
  "disallowed_extension",
  "executable_content_refused",
  "capability_refused",
  "replacement_file_not_found",
  "malformed_request",
]);
export type FileUploadAdmissionRefusalReason = z.infer<
  typeof fileUploadAdmissionRefusalReasonSchema
>;

export const fileUploadRenewalRefusalReasonSchema = z.enum([
  "caller_not_authorized",
  "field_not_writable",
  "file_not_found",
  "invalid_lifecycle_state",
  "grant_mismatch",
  "upload_expired",
  "malformed_request",
]);
export type FileUploadRenewalRefusalReason = z.infer<
  typeof fileUploadRenewalRefusalReasonSchema
>;

export const fileUploadCompletionRefusalReasonSchema = z.enum([
  "caller_not_authorized",
  "field_not_writable",
  "file_not_found",
  "invalid_lifecycle_state",
  "upload_incomplete",
  "upload_expired",
  "revision_conflict",
]);
export type FileUploadCompletionRefusalReason = z.infer<
  typeof fileUploadCompletionRefusalReasonSchema
>;

export const fileUploadActivationRefusalReasonSchema = z.enum([
  "caller_not_authorized",
  "field_not_writable",
  "file_not_found",
  "invalid_lifecycle_state",
  "owner_mismatch",
  "replacement_file_not_found",
  "upload_expired",
  "revision_conflict",
]);
export type FileUploadActivationRefusalReason = z.infer<
  typeof fileUploadActivationRefusalReasonSchema
>;

export const activityActorKindSchema = z.enum([
  "identity",
  "organization_account",
  "system",
  "public_session",
]);

export const activitySourceSchema = z.enum([
  "web",
  "workflow",
  "interface",
  "connection",
  "federation",
  "system",
]);

export const activityOutcomeSchema = z.enum(["completed", "refused", "failed"]);

/**
 * The two protected Activity projections. Every caller may read the activity
 * they performed (`own`); the organisation-wide `audit` projection additionally
 * requires the organisation's access-administration read authority, so a plain
 * account never enumerates another account's activity.
 */
export const activityProjectionSchema = z.enum(["own", "audit"]);

/** Bounded Activity filters. Every filter is optional and combined conjunctively. */
export const activityHistoryFilterSchema = z
  .object({
    occurredFrom: timestampSchema.optional(),
    occurredTo: timestampSchema.optional(),
    actorKind: activityActorKindSchema.optional(),
    actorId: actorIdSchema.optional(),
    action: builderKeySchema.optional(),
    correlationId: correlationIdSchema.optional(),
    outcome: activityOutcomeSchema.optional(),
    source: activitySourceSchema.optional(),
  })
  .strict()
  .refine(
    (filter) =>
      filter.occurredFrom === undefined ||
      filter.occurredTo === undefined ||
      Date.parse(filter.occurredFrom) <= Date.parse(filter.occurredTo),
    { message: "An Activity window cannot start after it ends" },
  );

/** The bounded dimension one Activity aggregate may group by. */
export const activityAggregateDimensionSchema = z.enum([
  "action",
  "actorKind",
  "source",
  "outcome",
]);
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
/** Route that produced a metering event; federation is the only cross-cluster route. */
export const meteringEventSourceSchema = z.enum([
  "web",
  "workflow",
  "interface",
  "connection",
  "federation",
  "system",
]);
/**
 * The single party an accepted quantity is allocated to. Local consumption is
 * owned by the local organisation; federated consumption is owned by exactly one
 * of the source or recipient organisation, so a linked pair is never counted twice.
 */
export const meteringAllocationOwnerSchema = z.enum([
  "local",
  "federated_source",
  "federated_recipient",
]);
/**
 * A correction is a later event linked to one original event of the same scope,
 * capability and unit. Its positive quantity is added to or removed from the
 * original; the original is never rewritten.
 */
export const meteringCorrectionDirectionSchema = z.enum(["increase", "decrease"]);
/**
 * Dimension-name words that would describe commercial or credential state. Metering
 * is generic evidence, so such a dimension is refused rather than stored.
 */
export const meteringForbiddenDimensionWords = Object.freeze([
  "amount",
  "billing",
  "charge",
  "chargeable",
  "cost",
  "credential",
  "currency",
  "customer",
  "invoice",
  "password",
  "payment",
  "plan",
  "price",
  "pricing",
  "secret",
  "subscription",
] as const);
const forbiddenMeteringDimensionWords: ReadonlySet<string> = new Set<string>(
  meteringForbiddenDimensionWords,
);
export const meteringDimensionKeySchema = builderKeySchema.refine(
  (key) => key.split("_").every((word) => !forbiddenMeteringDimensionWords.has(word)),
  { message: "Metering dimensions cannot describe commercial or credential state" },
);
/**
 * One bounded, non-secret dimension value available for later permitted grouping:
 * a lowercase identifier token (never free text, addresses or mixed-case
 * credentials), a boolean or a safe integer.
 */
export const meteringDimensionValueSchema = z.union([
  z
    .string()
    .min(1)
    .max(120)
    .regex(
      /^[a-z0-9](?:[a-z0-9_.:-]*[a-z0-9])?$/,
      "Use a lowercase identifier token as a dimension value",
    ),
  z.boolean(),
  z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
]);
export const meteringEventDimensionsSchema = z
  .record(meteringDimensionKeySchema, meteringDimensionValueSchema)
  .refine((value) => Object.keys(value).length <= 16, {
    message: "A metering event accepts at most 16 bounded dimensions",
  });
const meteringEventFields = {
  /** Final committed operation identity; one original event per capability and unit. */
  operationId: platformIdSchema,
  tenantId: tenantIdSchema,
  organizationId: organizationIdSchema.optional(),
  allocationOwner: meteringAllocationOwnerSchema,
  capabilityKey: namespacedKeySchema,
  quantity: z.number().positive().finite().max(Number.MAX_SAFE_INTEGER),
  unit: builderKeySchema,
  occurredAt: timestampSchema,
  source: meteringEventSourceSchema,
  sourceEventId: eventIdSchema.optional(),
  dimensions: meteringEventDimensionsSchema,
  /** Unique per tenant; a repeated key replays the one stored event. */
  duplicateProtectionKey: duplicateProtectionKeySchema,
  correlationId: correlationIdSchema,
  correctsMeteringEventId: meteringEventIdSchema.optional(),
  correctionDirection: meteringCorrectionDirectionSchema.optional(),
};
type MeteringEventShape = {
  readonly source: z.infer<typeof meteringEventSourceSchema>;
  readonly allocationOwner: z.infer<typeof meteringAllocationOwnerSchema>;
  readonly correctsMeteringEventId?: unknown;
  readonly correctionDirection?: unknown;
};
const meteringAllocationMatchesRoute = (value: MeteringEventShape): boolean =>
  value.source === "federation"
    ? value.allocationOwner !== "local"
    : value.allocationOwner === "local";
const meteringCorrectionIsComplete = (value: MeteringEventShape): boolean =>
  (value.correctsMeteringEventId === undefined) === (value.correctionDirection === undefined);
const meteringAllocationMessage =
  "Federated consumption has one federated allocation owner and local consumption one local owner";
const meteringCorrectionMessage =
  "A correction names both the corrected event and its direction";
export const meteringEventSchema = z
  .object({
    meteringEventId: meteringEventIdSchema,
    ...meteringEventFields,
    acceptedAt: timestampSchema,
  })
  .strict()
  .refine(meteringAllocationMatchesRoute, {
    path: ["allocationOwner"],
    message: meteringAllocationMessage,
  })
  .refine(meteringCorrectionIsComplete, {
    path: ["correctionDirection"],
    message: meteringCorrectionMessage,
  });
/** The final committed operation supplies immutable metering input exactly once. */
export const recordMeteringEventCommandSchema = z
  .object(meteringEventFields)
  .strict()
  .refine(meteringAllocationMatchesRoute, {
    path: ["allocationOwner"],
    message: meteringAllocationMessage,
  })
  .refine(meteringCorrectionIsComplete, {
    path: ["correctionDirection"],
    message: meteringCorrectionMessage,
  });
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
export type EventOccurrenceEnvelopeV2 = z.infer<typeof eventOccurrenceEnvelopeV2Schema>;
export type LiveInvalidation = z.infer<typeof liveInvalidationSchema>;
export type FileLifecycleState = z.infer<typeof fileLifecycleStateSchema>;
export type VerifiedFileActor = z.infer<typeof verifiedFileActorSchema>;
export type PrivateFileBucket = z.infer<typeof privateFileBucketSchema>;
export type FileStorageOperation = z.infer<typeof fileStorageOperationSchema>;
export type FileStorageOperationClaims = z.infer<typeof fileStorageOperationClaimsSchema>;
export type FileRecord = z.infer<typeof fileRecordSchema>;
export type UploadGrant = z.infer<typeof uploadGrantSchema>;
export type DownloadGrant = z.infer<typeof downloadGrantSchema>;
export type ActivitySource = z.infer<typeof activitySourceSchema>;
export type ActivityOutcome = z.infer<typeof activityOutcomeSchema>;
export type ActivityProjection = z.infer<typeof activityProjectionSchema>;
export type ActivityHistoryFilter = z.infer<typeof activityHistoryFilterSchema>;
export type ActivityAggregateDimension = z.infer<typeof activityAggregateDimensionSchema>;
export type EntitlementCheckRequest = z.infer<typeof entitlementCheckRequestSchema>;
export type MeteringEvent = z.infer<typeof meteringEventSchema>;
export type MeteringEventSource = z.infer<typeof meteringEventSourceSchema>;
export type MeteringAllocationOwner = z.infer<typeof meteringAllocationOwnerSchema>;
export type MeteringCorrectionDirection = z.infer<typeof meteringCorrectionDirectionSchema>;
export type MeteringEventDimensions = z.infer<typeof meteringEventDimensionsSchema>;
export type RecordMeteringEventCommand = z.infer<typeof recordMeteringEventCommandSchema>;
export type SafeErrorResponse = z.infer<typeof safeErrorResponseSchema>;
