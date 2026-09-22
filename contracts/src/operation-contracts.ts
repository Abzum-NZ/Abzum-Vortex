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
    owningAttachmentReferences: z.array(platformIdSchema),
    ownerRecordTypeId: recordTypeIdSchema.optional(),
    ownerRecordId: recordIdSchema.optional(),
    ownerFieldId: fieldIdSchema.optional(),
    legalHold: z.boolean(),
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
