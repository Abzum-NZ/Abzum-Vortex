import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  MAXIMUM_FILE_STORAGE_OPERATION_SECONDS,
  PRIVATE_FILE_BUCKET,
  fileIdSchema,
  fileRecordSchema,
  fingerprintSchema,
  platformIdSchema,
  trustedFileInspectionSchema,
  uploadGrantSchema,
  type ApplicationRootId,
  type CorrelationId,
  type FieldId,
  type FileId,
  type FileRecord,
  type FileUploadAdmissionRefusalReason,
  type FileUploadCompletionRefusalReason,
  type FileUploadRenewalRefusalReason,
  type FileUploadScanOutcome,
  type Fingerprint,
  type OrganizationId,
  type PlatformId,
  type RecordId,
  type RecordTypeId,
  type SessionContext,
  type TrustedFileInspection,
  type UploadGrant,
} from "@vortex/contracts";
import { createUnguessableStorageKey } from "./storage-policy";
import {
  isExecutableContent,
  normalizeFileExtension,
  verifyContentSafety,
} from "./content-safety";
import {
  PREFLIGHT_SCANNER_NAME,
  PREFLIGHT_SCANNER_VERSION,
  createFileRecord,
  recordFileSafetyResult,
  transitionFileLifecycleState,
  type FileAttachmentConstraints,
} from "./file-metadata";
import {
  resolveVerifiedFileActor,
  verifyAttachmentFieldAuthority,
} from "./attachment-authority";
import type {
  BrowserUploadGrant,
  CurrentStorageAuthority,
  ResolveCurrentStorageAuthority,
  StorageCredentialBridge,
} from "./storage-credentials";
import {
  runUploadCapabilityAdmission,
  type CapabilityReservationResult,
  type UploadCapabilityAdmissionRequest,
  type UploadCapabilityReservationPorts,
} from "./upload-capability-admission";

/**
 * Durable repository boundary for reserving, renewing, and completing file uploads.
 */
export type FileUploadRepository = Readonly<{
  readFileRecord(fileId: FileId): Promise<FileRecord | null>;
  readFileRecordByGrant?(oneTimeId: PlatformId): Promise<FileRecord | null>;
  insertPendingFile(
    fileRecord: FileRecord,
    uploadGrant: UploadGrant,
    replacingFileId?: FileId,
  ): Promise<void>;
  updatePendingGrant(
    fileId: FileId,
    previousOneTimeId: PlatformId,
    newUploadGrant: UploadGrant,
  ): Promise<void>;
  readUploadGrant(oneTimeId: PlatformId): Promise<UploadGrant | null>;
  completeFileUpload(
    fileRecord: FileRecord,
    consumedGrantId?: PlatformId,
  ): Promise<FileRecord>;
}>;

export type FileUploadAdmissionInput = Readonly<{
  sessionContext: SessionContext;
  organizationId: OrganizationId;
  applicationRootId?: ApplicationRootId;
  recordTypeId: RecordTypeId;
  recordId: RecordId;
  fieldId: FieldId;
  readableFieldIds: readonly FieldId[];
  changeableFieldIds: readonly FieldId[];
  rawFilename: string;
  claimedSizeBytes: number;
  claimedMediaType?: string;
  claimedExtension?: string;
  replacingFileId?: FileId;
  existingAttachmentCount: number;
  attachmentConstraints?: FileAttachmentConstraints;
  capabilityAdmission?: UploadCapabilityAdmissionRequest;
  capabilityReservation?: CapabilityReservationResult;
  capabilityPorts?: UploadCapabilityReservationPorts;
  correlationId?: CorrelationId;
  ttlSeconds?: number;
  clock?: () => Date;
}>;

export type FileUploadAdmissionResult =
  | Readonly<{
      outcome: "admitted";
      fileId: FileId;
      storageKey: string;
      uploadGrant: UploadGrant;
      browserUploadGrant: BrowserUploadGrant;
      fileRecord: FileRecord;
    }>
  | Readonly<{
      outcome: "refused";
      reason: FileUploadAdmissionRefusalReason;
      message: string;
    }>;

export type FileUploadRenewalInput = Readonly<{
  sessionContext: SessionContext;
  fileId: FileId;
  oneTimeId: PlatformId;
  readableFieldIds: readonly FieldId[];
  changeableFieldIds: readonly FieldId[];
  ttlSeconds?: number;
  correlationId?: CorrelationId;
  clock?: () => Date;
}>;

export type FileUploadRenewalResult =
  | Readonly<{
      outcome: "renewed";
      fileId: FileId;
      uploadGrant: UploadGrant;
      browserUploadGrant: BrowserUploadGrant;
    }>
  | Readonly<{
      outcome: "refused";
      reason: FileUploadRenewalRefusalReason;
      message: string;
    }>;

export type FileUploadCompletionInput = Readonly<{
  sessionContext: SessionContext;
  fileId: FileId;
  oneTimeId?: PlatformId;
  readableFieldIds: readonly FieldId[];
  changeableFieldIds: readonly FieldId[];
  inspection: TrustedFileInspection;
  scanOutcome?: FileUploadScanOutcome;
  replacingFileId?: FileId;
  existingAttachmentCount?: number;
  attachmentConstraints?: FileAttachmentConstraints;
  clock?: () => Date;
}>;

export type FileUploadCompletionResult =
  | Readonly<{
      outcome: "active";
      fileRecord: FileRecord;
    }>
  | Readonly<{
      outcome: "quarantined";
      fileRecord: FileRecord;
      reason: string;
    }>
  | Readonly<{
      outcome: "refused";
      reason: FileUploadCompletionRefusalReason;
      message: string;
    }>;

export type FileUploadCoordinatorDependencies = Readonly<{
  repository: FileUploadRepository;
  bridge: StorageCredentialBridge;
  clock?: () => Date;
}>;

export type FileUploadCoordinator = Readonly<{
  admitUpload(input: FileUploadAdmissionInput): Promise<FileUploadAdmissionResult>;
  renewUpload(input: FileUploadRenewalInput): Promise<FileUploadRenewalResult>;
  completeUpload(input: FileUploadCompletionInput): Promise<FileUploadCompletionResult>;
}>;

const derivePolicyFingerprint = (parts: readonly unknown[]): Fingerprint => {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(typeof part === "string" ? part : JSON.stringify(part));
  }
  return fingerprintSchema.parse(`sha256:${hash.digest("hex")}`);
};

/**
 * In-memory reference repository for unit and service-level file upload execution.
 */
export const createInMemoryFileUploadRepository = (): FileUploadRepository => {
  const fileRecords = new Map<string, FileRecord>();
  const uploadGrants = new Map<string, UploadGrant>();
  const grantToFileId = new Map<string, FileId>();
  const consumedGrants = new Set<string>();

  const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

  return Object.freeze({
    async readFileRecord(fileId: FileId): Promise<FileRecord | null> {
      const record = fileRecords.get(fileId.toLowerCase());
      return record ? deepClone(record) : null;
    },

    async readFileRecordByGrant(oneTimeId: PlatformId): Promise<FileRecord | null> {
      const fileId = grantToFileId.get(oneTimeId.toLowerCase());
      if (!fileId) return null;
      const record = fileRecords.get(fileId.toLowerCase());
      return record ? deepClone(record) : null;
    },

    async insertPendingFile(
      fileRecord: FileRecord,
      uploadGrant: UploadGrant,
    ): Promise<void> {
      const validatedRecord = fileRecordSchema.parse(fileRecord);
      const validatedGrant = uploadGrantSchema.parse(uploadGrant);
      fileRecords.set(validatedRecord.fileId.toLowerCase(), deepClone(validatedRecord));
      uploadGrants.set(validatedGrant.oneTimeId.toLowerCase(), deepClone(validatedGrant));
      grantToFileId.set(validatedGrant.oneTimeId.toLowerCase(), validatedRecord.fileId);
    },

    async updatePendingGrant(
      fileId: FileId,
      previousOneTimeId: PlatformId,
      newUploadGrant: UploadGrant,
    ): Promise<void> {
      const validatedGrant = uploadGrantSchema.parse(newUploadGrant);
      consumedGrants.add(previousOneTimeId.toLowerCase());
      uploadGrants.set(validatedGrant.oneTimeId.toLowerCase(), deepClone(validatedGrant));
      grantToFileId.set(validatedGrant.oneTimeId.toLowerCase(), fileId);
    },

    async readUploadGrant(oneTimeId: PlatformId): Promise<UploadGrant | null> {
      const normalized = oneTimeId.toLowerCase();
      if (consumedGrants.has(normalized)) return null;
      const grant = uploadGrants.get(normalized);
      return grant ? deepClone(grant) : null;
    },

    async completeFileUpload(
      fileRecord: FileRecord,
      consumedGrantId?: PlatformId,
    ): Promise<FileRecord> {
      const validatedRecord = fileRecordSchema.parse(fileRecord);
      if (consumedGrantId) {
        consumedGrants.add(consumedGrantId.toLowerCase());
      }
      for (const [grantId, fId] of grantToFileId.entries()) {
        if (fId.toLowerCase() === validatedRecord.fileId.toLowerCase()) {
          consumedGrants.add(grantId);
        }
      }
      fileRecords.set(validatedRecord.fileId.toLowerCase(), deepClone(validatedRecord));
      return deepClone(validatedRecord);
    },
  });
};

/**
 * Creates an authority resolver for the StorageCredentialBridge backed by the FileUploadRepository.
 */
export const createUploadStorageAuthorityResolver = (
  repository: FileUploadRepository,
  clock: () => Date = () => new Date(),
): ResolveCurrentStorageAuthority => {
  return async (request) => {
    if (request.operation !== "upload") {
      return { authorized: false };
    }

    const grantCandidate = uploadGrantSchema.safeParse(request.grant);
    if (!grantCandidate.success) {
      return { authorized: false };
    }
    const grant = grantCandidate.data;

    const recordedGrant = await repository.readUploadGrant(grant.oneTimeId);
    if (!recordedGrant) {
      return { authorized: false };
    }

    const fileRecord = repository.readFileRecordByGrant
      ? await repository.readFileRecordByGrant(grant.oneTimeId)
      : null;

    if (!fileRecord) {
      return { authorized: false };
    }

    if (
      fileRecord.lifecycleState !== "pending" ||
      fileRecord.scannerResult !== "pending" ||
      fileRecord.organizationId !== grant.organizationId ||
      fileRecord.ownerRecordTypeId !== grant.recordTypeId ||
      fileRecord.ownerRecordId !== grant.recordId ||
      fileRecord.ownerFieldId !== grant.fieldId
    ) {
      return { authorized: false };
    }

    const nowEpochSeconds = Math.floor(clock().getTime() / 1_000);
    const grantExpiryEpochSeconds = Math.floor(Date.parse(grant.expiresAt) / 1_000);
    if (!Number.isFinite(grantExpiryEpochSeconds) || grantExpiryEpochSeconds <= nowEpochSeconds) {
      return { authorized: false };
    }

    const resolution: CurrentStorageAuthority = {
      authorized: true,
      operation: "upload",
      organizationId: fileRecord.organizationId,
      fileId: fileRecord.fileId,
      fileRecord,
      actor: grant.actor,
      correlationId: (grant as unknown as { correlationId?: string }).correlationId ?? fileRecord.fileId,
      validUntil: grant.expiresAt,
      transferGrantId: grant.oneTimeId,
    };

    return resolution;
  };
};

/**
 * Admits one upload by reserving pending file metadata and an exact-object upload grant.
 */
export const reservePendingUpload = async (
  dependencies: FileUploadCoordinatorDependencies,
  input: FileUploadAdmissionInput,
): Promise<FileUploadAdmissionResult> => {
  const clock = dependencies.clock ?? input.clock ?? (() => new Date());
  const now = clock();
  const nowIso = now.toISOString();

  // 1. Verify caller attribution
  const actorResolution = resolveVerifiedFileActor(
    input.sessionContext,
    input.organizationId,
  );
  if (!actorResolution.authorized) {
    return {
      outcome: "refused",
      reason: "caller_not_authorized",
      message: actorResolution.reason,
    };
  }
  const uploader = actorResolution.actor;

  // 2. Verify attachment field write authority
  const fieldAuthority = verifyAttachmentFieldAuthority({
    fieldId: input.fieldId,
    readableFieldIds: input.readableFieldIds,
    changeableFieldIds: input.changeableFieldIds,
    operation: "write",
  });
  if (!fieldAuthority.authorized) {
    return {
      outcome: "refused",
      reason: "field_not_writable",
      message: fieldAuthority.reason,
    };
  }

  // 3. Preflight attachment constraints and file size bounds
  const constraints = input.attachmentConstraints;
  const maxFileSizeMb = constraints?.maxFileSizeMb;
  const maxAllowedBytes =
    maxFileSizeMb !== undefined && Number.isFinite(maxFileSizeMb) && maxFileSizeMb > 0
      ? Math.floor(maxFileSizeMb * 1024 * 1024)
      : 100 * 1024 * 1024;

  if (input.claimedSizeBytes > maxAllowedBytes) {
    return {
      outcome: "refused",
      reason: "file_size_exceeded",
      message: `Claimed file size ${input.claimedSizeBytes} bytes exceeds maximum allowed ${maxFileSizeMb ?? 100} MB`,
    };
  }

  // Check file count capacity
  const isMultiple = constraints?.multiple === true;
  const maxFiles = isMultiple ? (constraints?.maxFiles ?? 1) : 1;
  const isReplacing = input.replacingFileId !== undefined;
  const effectiveExistingCount = isReplacing
    ? Math.max(0, input.existingAttachmentCount - 1)
    : input.existingAttachmentCount;

  if (effectiveExistingCount >= maxFiles) {
    return {
      outcome: "refused",
      reason: "field_capacity_exceeded",
      message: `Attachment field already holds its maximum of ${maxFiles} file(s)`,
    };
  }

  // Preflight check for claimed extension / media type
  const normalizedExt = input.claimedExtension
    ? normalizeFileExtension(input.claimedExtension)
    : "";

  if (input.claimedMediaType && isExecutableContent(input.claimedMediaType, normalizedExt)) {
    return {
      outcome: "refused",
      reason: "executable_content_refused",
      message: "Executable content is refused by platform safety policy",
    };
  }

  // 4. Capability admission if configured
  if (input.capabilityAdmission && input.capabilityReservation && input.capabilityPorts) {
    const admissionResult = await runUploadCapabilityAdmission(
      input.capabilityPorts,
      input.capabilityAdmission,
      input.capabilityReservation,
      async () => ({ admitted: true }),
    );
    if (admissionResult.outcome === "refused") {
      return {
        outcome: "refused",
        reason: "capability_refused",
        message: `Upload capability reservation refused: ${admissionResult.reasonCode}`,
      };
    }
  }

  // 5. Generate pending FileRecord with unguessable storage key
  const fileId = randomUUID() as FileId;
  const maximumBytes = Math.min(
    input.claimedSizeBytes > 0 ? input.claimedSizeBytes : maxAllowedBytes,
    maxAllowedBytes,
  );

  const fileRecord = createFileRecord({
    organizationId: input.organizationId,
    ...(input.applicationRootId ? { applicationRootId: input.applicationRootId } : {}),
    owner: {
      recordTypeId: input.recordTypeId,
      recordId: input.recordId,
      fieldId: input.fieldId,
    },
    attachmentConstraints: constraints,
    existingAttachmentCount: effectiveExistingCount,
    rawFilename: input.rawFilename,
    detectedMediaType: input.claimedMediaType ?? "application/octet-stream",
    extension: normalizedExt,
    sizeBytes: maximumBytes,
    checksum: fingerprintSchema.parse(`sha256:${"0".repeat(64)}`),
    uploader,
    fileId,
    clock: () => now,
  });

  // 6. Generate exact-object UploadGrant
  const oneTimeId = randomUUID() as PlatformId;
  const ttlSeconds = Math.min(
    Math.max(1, Math.floor(input.ttlSeconds ?? MAXIMUM_FILE_STORAGE_OPERATION_SECONDS)),
    MAXIMUM_FILE_STORAGE_OPERATION_SECONDS,
  );
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000).toISOString();

  const policyFingerprint = derivePolicyFingerprint([
    input.organizationId,
    input.recordTypeId,
    input.recordId,
    input.fieldId,
    uploader,
    maximumBytes,
    expiresAt,
    oneTimeId,
  ]);

  const uploadGrant: UploadGrant = uploadGrantSchema.parse({
    kind: "upload",
    organizationId: input.organizationId,
    actor: uploader,
    recordTypeId: input.recordTypeId,
    recordId: input.recordId,
    fieldId: input.fieldId,
    maximumBytes,
    policyFingerprint,
    expiresAt,
    oneTimeId,
  });

  // 7. Persist pending file metadata and grant
  await dependencies.repository.insertPendingFile(
    fileRecord,
    uploadGrant,
    input.replacingFileId,
  );

  // 8. Mint browser upload grant
  const browserUploadGrant = await dependencies.bridge.mintBrowserUploadGrant({
    request: {
      operation: "upload",
      grant: uploadGrant,
    },
    ttlSeconds,
  });

  return {
    outcome: "admitted",
    fileId,
    storageKey: fileRecord.storageKey,
    uploadGrant,
    browserUploadGrant,
    fileRecord,
  };
};

/**
 * Renews an in-progress resumable upload grant under fresh authority checks.
 */
export const renewPendingUpload = async (
  dependencies: FileUploadCoordinatorDependencies,
  input: FileUploadRenewalInput,
): Promise<FileUploadRenewalResult> => {
  const clock = dependencies.clock ?? input.clock ?? (() => new Date());
  const now = clock();
  const nowEpochSeconds = Math.floor(now.getTime() / 1_000);

  // 1. Read existing pending FileRecord
  const fileRecord = await dependencies.repository.readFileRecord(input.fileId);
  if (!fileRecord) {
    return {
      outcome: "refused",
      reason: "file_not_found",
      message: `File record ${input.fileId} not found`,
    };
  }

  if (fileRecord.lifecycleState !== "pending") {
    return {
      outcome: "refused",
      reason: "invalid_lifecycle_state",
      message: `File record ${input.fileId} is '${fileRecord.lifecycleState}', not pending`,
    };
  }

  // 2. Re-check current authority
  const actorResolution = resolveVerifiedFileActor(
    input.sessionContext,
    fileRecord.organizationId,
  );
  if (!actorResolution.authorized) {
    return {
      outcome: "refused",
      reason: "caller_not_authorized",
      message: actorResolution.reason,
    };
  }

  const fieldAuthority = verifyAttachmentFieldAuthority({
    fieldId: fileRecord.ownerFieldId!,
    readableFieldIds: input.readableFieldIds,
    changeableFieldIds: input.changeableFieldIds,
    operation: "write",
  });
  if (!fieldAuthority.authorized) {
    return {
      outcome: "refused",
      reason: "field_not_writable",
      message: fieldAuthority.reason,
    };
  }

  // 3. Read previous grant
  const previousGrant = await dependencies.repository.readUploadGrant(input.oneTimeId);
  if (!previousGrant) {
    return {
      outcome: "refused",
      reason: "grant_mismatch",
      message: `Previous upload grant ${input.oneTimeId} was not found or has been consumed`,
    };
  }

  if (
    previousGrant.organizationId !== fileRecord.organizationId ||
    previousGrant.recordTypeId !== fileRecord.ownerRecordTypeId ||
    previousGrant.recordId !== fileRecord.ownerRecordId ||
    previousGrant.fieldId !== fileRecord.ownerFieldId
  ) {
    return {
      outcome: "refused",
      reason: "grant_mismatch",
      message: "Previous upload grant does not match file ownership scope",
    };
  }

  // 4. Mint renewed UploadGrant
  const newOneTimeId = randomUUID() as PlatformId;
  const ttlSeconds = Math.min(
    Math.max(1, Math.floor(input.ttlSeconds ?? MAXIMUM_FILE_STORAGE_OPERATION_SECONDS)),
    MAXIMUM_FILE_STORAGE_OPERATION_SECONDS,
  );
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000).toISOString();

  const newPolicyFingerprint = derivePolicyFingerprint([
    fileRecord.organizationId,
    fileRecord.ownerRecordTypeId,
    fileRecord.ownerRecordId,
    fileRecord.ownerFieldId,
    actorResolution.actor,
    previousGrant.maximumBytes,
    expiresAt,
    newOneTimeId,
  ]);

  const renewedGrant: UploadGrant = uploadGrantSchema.parse({
    kind: "upload",
    organizationId: fileRecord.organizationId,
    actor: actorResolution.actor,
    recordTypeId: fileRecord.ownerRecordTypeId!,
    recordId: fileRecord.ownerRecordId!,
    fieldId: fileRecord.ownerFieldId!,
    maximumBytes: previousGrant.maximumBytes,
    policyFingerprint: newPolicyFingerprint,
    expiresAt,
    oneTimeId: newOneTimeId,
  });

  // 5. Persist renewed grant
  await dependencies.repository.updatePendingGrant(
    fileRecord.fileId,
    input.oneTimeId,
    renewedGrant,
  );

  // 6. Mint renewed browser credential
  const browserUploadGrant = await dependencies.bridge.mintBrowserUploadGrant({
    request: {
      operation: "upload",
      grant: renewedGrant,
    },
    ttlSeconds,
  });

  return {
    outcome: "renewed",
    fileId: fileRecord.fileId,
    uploadGrant: renewedGrant,
    browserUploadGrant,
  };
};

/**
 * Completes an upload by deriving actual size, detected media type, extension and checksum
 * from trusted inspection, applying isolated scan outcome, and rechecking current authority before activation.
 */
export const completeFileUpload = async (
  dependencies: FileUploadCoordinatorDependencies,
  input: FileUploadCompletionInput,
): Promise<FileUploadCompletionResult> => {
  const clock = dependencies.clock ?? input.clock ?? (() => new Date());
  const now = clock();

  // 1. Read existing FileRecord
  const fileRecord = await dependencies.repository.readFileRecord(input.fileId);
  if (!fileRecord) {
    return {
      outcome: "refused",
      reason: "file_not_found",
      message: `File record ${input.fileId} not found`,
    };
  }

  if (fileRecord.lifecycleState !== "pending" && fileRecord.lifecycleState !== "uploaded") {
    return {
      outcome: "refused",
      reason: "invalid_lifecycle_state",
      message: `File record ${input.fileId} is '${fileRecord.lifecycleState}', not pending or uploaded`,
    };
  }

  // 2. Re-check current authority
  const actorResolution = resolveVerifiedFileActor(
    input.sessionContext,
    fileRecord.organizationId,
  );
  if (!actorResolution.authorized) {
    return {
      outcome: "refused",
      reason: "caller_not_authorized",
      message: actorResolution.reason,
    };
  }

  const fieldAuthority = verifyAttachmentFieldAuthority({
    fieldId: fileRecord.ownerFieldId!,
    readableFieldIds: input.readableFieldIds,
    changeableFieldIds: input.changeableFieldIds,
    operation: "write",
  });
  if (!fieldAuthority.authorized) {
    return {
      outcome: "refused",
      reason: "field_not_writable",
      message: fieldAuthority.reason,
    };
  }

  // 3. Trusted content inspection derivation
  const inspectionCandidate = trustedFileInspectionSchema.safeParse(input.inspection);
  if (!inspectionCandidate.success) {
    return {
      outcome: "refused",
      reason: "content_safety_refused",
      message: "Trusted file inspection data is malformed or invalid",
    };
  }
  const inspection = inspectionCandidate.data;
  const actualSizeBytes = inspection.actualSizeBytes;
  const detectedMediaType = inspection.detectedMediaType;
  const normalizedExtension = normalizeFileExtension(inspection.detectedExtension);
  const checksum = inspection.checksum;

  // 4. Move to uploaded lifecycle
  const uploadedRecord =
    fileRecord.lifecycleState === "pending"
      ? transitionFileLifecycleState(fileRecord, "uploaded", { clock: () => now })
      : fileRecord;

  // 5. Evaluate content safety against canonical attachment settings
  const constraints = input.attachmentConstraints;
  const isReplacing = input.replacingFileId !== undefined;
  const existingCount = input.existingAttachmentCount ?? 0;
  const effectiveCount = isReplacing ? Math.max(0, existingCount - 1) : existingCount;

  const safetyResult = verifyContentSafety({
    detectedMediaType,
    extension: normalizedExtension,
    sizeBytes: actualSizeBytes,
    existingAttachmentCount: effectiveCount,
    ...(constraints?.allowedKinds ? { allowedKinds: constraints.allowedKinds } : {}),
    ...(constraints?.allowedExtensions ? { allowedExtensions: constraints.allowedExtensions } : {}),
    ...(constraints?.maxFileSizeMb !== undefined ? { maxFileSizeMb: constraints.maxFileSizeMb } : {}),
    ...(constraints?.multiple !== undefined ? { multiple: constraints.multiple } : {}),
    ...(constraints?.maxFiles !== undefined ? { maxFiles: constraints.maxFiles } : {}),
  });

  if (!safetyResult.accepted && safetyResult.outcome === "refused") {
    return {
      outcome: "refused",
      reason: "content_safety_refused",
      message: safetyResult.reason,
    };
  }

  // 6. Transition to scanning lifecycle
  const scanningRecord = transitionFileLifecycleState(uploadedRecord, "scanning", {
    clock: () => now,
  });

  // 7. Apply isolated scanner outcome and safety decision
  const scannerOutcome = input.scanOutcome;
  const scannerName = scannerOutcome?.scannerName ?? PREFLIGHT_SCANNER_NAME;
  const scannerVersion = scannerOutcome?.scannerVersion ?? PREFLIGHT_SCANNER_VERSION;

  if (scannerOutcome?.scannerResult === "refused") {
    return {
      outcome: "refused",
      reason: "scan_refused",
      message: scannerOutcome.reason ?? "Isolated scanner refused content",
    };
  }

  const isQuarantined =
    !safetyResult.accepted || scannerOutcome?.scannerResult === "quarantined";

  if (isQuarantined) {
    const quarantineReason = !safetyResult.accepted
      ? safetyResult.reason
      : (scannerOutcome?.reason ?? "File quarantined by isolated scanner");

    const quarantinedRecord = recordFileSafetyResult(
      {
        ...scanningRecord,
        sizeBytes: actualSizeBytes,
        detectedMediaType,
        extension: normalizedExtension,
        checksum,
      },
      {
        scannerName,
        scannerVersion,
        scannerResult: "quarantined",
      },
    );

    const persisted = await dependencies.repository.completeFileUpload(
      quarantinedRecord,
      input.oneTimeId,
    );

    return {
      outcome: "quarantined",
      fileRecord: persisted,
      reason: quarantineReason,
    };
  }

  // 8. Clean scan outcome
  const cleanScanningRecord = recordFileSafetyResult(
    {
      ...scanningRecord,
      sizeBytes: actualSizeBytes,
      detectedMediaType,
      extension: normalizedExtension,
      checksum,
    },
    {
      scannerName,
      scannerVersion,
      scannerResult: "clean",
    },
  );

  // 9. Re-check current authority right before activation
  const freshActorCheck = resolveVerifiedFileActor(
    input.sessionContext,
    fileRecord.organizationId,
  );
  if (!freshActorCheck.authorized) {
    return {
      outcome: "refused",
      reason: "caller_not_authorized",
      message: freshActorCheck.reason,
    };
  }

  const freshFieldCheck = verifyAttachmentFieldAuthority({
    fieldId: fileRecord.ownerFieldId!,
    readableFieldIds: input.readableFieldIds,
    changeableFieldIds: input.changeableFieldIds,
    operation: "write",
  });
  if (!freshFieldCheck.authorized) {
    return {
      outcome: "refused",
      reason: "field_not_writable",
      message: freshFieldCheck.reason,
    };
  }

  // 10. Activate file record
  const activeRecord = transitionFileLifecycleState(cleanScanningRecord, "active", {
    clock: () => now,
  });

  // 11. Persist completed active file record
  const persistedActiveRecord = await dependencies.repository.completeFileUpload(
    activeRecord,
    input.oneTimeId,
  );

  return {
    outcome: "active",
    fileRecord: persistedActiveRecord,
  };
};

/**
 * Composes file contracts, capability admission, storage credentials, content safety,
 * isolated scanning, and attachment authority into one file upload coordinator.
 */
export const createFileUploadCoordinator = (
  dependencies: FileUploadCoordinatorDependencies,
): FileUploadCoordinator => {
  return Object.freeze({
    admitUpload: (input) => reservePendingUpload(dependencies, input),
    renewUpload: (input) => renewPendingUpload(dependencies, input),
    completeUpload: (input) => completeFileUpload(dependencies, input),
  });
};
