import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { SessionContext } from "../access/identity-access";
import { correlationIdSchema, type CorrelationId } from "../catalogue/common";
import {
  fileIdSchema,
  fingerprintSchema,
  platformIdSchema,
  timestampSchema,
  type ApplicationRootId,
  type FieldId,
  type FileId,
  type Fingerprint,
  type OrganizationId,
  type PlatformId,
  type RecordId,
  type RecordTypeId,
} from "../catalogue/identifiers";
import { sameId } from "../catalogue/runtime-primitives";
import {
  MAXIMUM_FILE_STORAGE_OPERATION_SECONDS,
  PRIVATE_FILE_BUCKET,
  fileRecordSchema,
  fileUploadCompletionRefusalReasonSchema,
  fileUploadRenewalRefusalReasonSchema,
  trustedFileInspectionSchema,
  uploadGrantSchema,
  verifiedFileActorSchema,
  type FileRecord,
  type FileUploadAdmissionRefusalReason,
  type FileUploadCompletionRefusalReason,
  type FileUploadRenewalRefusalReason,
  type TrustedFileInspection,
  type UploadGrant,
  type VerifiedFileActor,
} from "./file-contracts";
import { createUnguessableStorageKey } from "./storage-policy";
import {
  expectedContentKindsForExtension,
  isExecutableContent,
  normalizeFileExtension,
  verifyContentSafety,
  type ContentKind,
} from "./content-safety";
import {
  PREFLIGHT_SCANNER_NAME,
  PREFLIGHT_SCANNER_VERSION,
  recordFileSafetyResult,
  sanitizeFileDisplayName,
  transitionFileLifecycleState,
} from "./file-metadata";
import { resolveVerifiedFileActor, verifyAttachmentFieldAuthority } from "./attachment-authority";
import type {
  BrowserUploadGrant,
  ResolveCurrentStorageAuthority,
  StorageCredentialBridge,
} from "./storage-credentials";
import type { RequestDatabaseTransaction } from "../db/request-transaction";

/**
 * How long an admitted upload may stay pending, across every resumable renewal.
 * It matches the provider's resumable upload session lifetime; each browser
 * credential inside it still lasts at most 60 seconds.
 */
export const PENDING_UPLOAD_WINDOW_SECONDS = 24 * 60 * 60;

/** Placeholder content metadata a pending file carries until trusted inspection replaces it. */
const PENDING_MEDIA_TYPE = "application/octet-stream";
const PENDING_CHECKSUM = fingerprintSchema.parse(`sha256:${"0".repeat(64)}`);

/**
 * The canonical attachment settings of the published field, resolved by trusted
 * server wiring rather than supplied by the request.
 */
export type UploadAttachmentSettings = Readonly<{
  allowedKinds: readonly ContentKind[];
  allowedExtensions?: readonly string[] | undefined;
  maxFileSizeMb: number;
  multiple: boolean;
  maxFiles?: number | undefined;
}>;

type AttachmentOwner = Readonly<{
  recordTypeId: RecordTypeId;
  recordId?: RecordId | undefined;
  fieldId: FieldId;
}>;

/**
 * The current record and field authority of this request, resolved by the
 * ordinary Access operation for the effective actor on one record. Every upload
 * step takes it afresh; none reuses an earlier step's authority. The field
 * permissions apply only to the record named here, so continuing an upload
 * requires that record to be the file's own owning record.
 */
type CurrentUploadAuthority = Readonly<{
  sessionContext: SessionContext;
  /** The record the field permissions below were resolved for. */
  recordTypeId: RecordTypeId;
  recordId?: RecordId | undefined;
  readableFieldIds: readonly FieldId[];
  changeableFieldIds: readonly FieldId[];
}>;

/** One admitted upload's durable state, read inside the current request's organisation. */
export type PendingUploadState = Readonly<{
  fileRecord: FileRecord;
  uploader: VerifiedFileActor;
  maximumBytes: number;
  uploadExpiresAt: string;
  replacingFileId?: FileId | undefined;
  /** The one unsuperseded upload grant, while the upload still accepts bytes. */
  currentGrantId?: PlatformId | undefined;
  correlationId: CorrelationId;
  revision: number;
}>;

export type PendingUploadReservation = Readonly<{
  fileRecord: FileRecord;
  grant: UploadGrant;
  correlationId: CorrelationId;
  uploadExpiresAt: string;
  replacingFileId?: FileId | undefined;
  existingAttachmentCount: number;
  maxFiles: number;
}>;

export type ClaimedUploadGrant = Readonly<{
  grant: UploadGrant;
  fileRecord: FileRecord;
  correlationId: CorrelationId;
}>;

const storedPendingUploadSchema = z
  .object({
    fileRecord: fileRecordSchema,
    uploader: verifiedFileActorSchema,
    maximumBytes: z.number().int().positive(),
    uploadExpiresAt: timestampSchema,
    replacingFileId: fileIdSchema.optional(),
    currentGrantId: platformIdSchema.optional(),
    correlationId: correlationIdSchema,
    revision: z.number().int().positive(),
  })
  .strict();
const storedReservationSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("reserved"), fileRecord: fileRecordSchema }).strict(),
  z
    .object({
      outcome: z.literal("refused"),
      reason: z.enum(["field_capacity_exceeded", "replacement_file_not_found"]),
    })
    .strict(),
]);
const storedRenewalSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("renewed") }).strict(),
  z
    .object({
      outcome: z.literal("refused"),
      reason: fileUploadRenewalRefusalReasonSchema.exclude([
        "field_not_writable",
        "malformed_request",
      ]),
    })
    .strict(),
]);
const storedCompletionSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("recorded"), fileRecord: fileRecordSchema }).strict(),
  z
    .object({
      outcome: z.literal("refused"),
      reason: fileUploadCompletionRefusalReasonSchema.exclude([
        "field_not_writable",
        "upload_incomplete",
      ]),
    })
    .strict(),
]);

const claimedUploadGrantSchema = z
  .object({
    grant: uploadGrantSchema,
    fileRecord: fileRecordSchema,
    correlationId: correlationIdSchema,
  })
  .strict();

/**
 * Durable upload state belongs to the protected request transaction. Every write checks the
 * upload's revision, runs inside the request's own organisation and verifies that the request
 * actor is the uploader. The `vortex_platform` upload functions are the canonical implementation.
 */
const callUploadOperation = async (
  transaction: RequestDatabaseTransaction,
  operation: "reserve" | "read" | "renew" | "claim" | "complete",
  input: unknown,
): Promise<unknown> => {
  const rows = await transaction.query<{
    result: unknown;
  }>`select vortex_platform.file_upload_operation(${operation}::text,${JSON.stringify(input)}::text::jsonb) as result`;
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("FILE_UPLOAD_RESULT_INVALID");
  return rows[0].result;
};

/**
 * Locks the owning field and checks current authority and active capacity, including the
 * replacement target. Pending metadata and its first grant are inserted together. The record save
 * enforces the final attachment capacity.
 */
const reserveStoredUpload = async (
  transaction: RequestDatabaseTransaction,
  reservation: PendingUploadReservation,
): Promise<
  | Readonly<{ outcome: "reserved"; fileRecord: FileRecord }>
  | Readonly<{
      outcome: "refused";
      reason: "field_capacity_exceeded" | "replacement_file_not_found";
    }>
> => storedReservationSchema.parse(await callUploadOperation(transaction, "reserve", reservation));

export const readStoredPendingUpload = async (
  transaction: RequestDatabaseTransaction,
  fileId: FileId,
): Promise<PendingUploadState | null> =>
  storedPendingUploadSchema
    .nullable()
    .parse(await callUploadOperation(transaction, "read", { fileId }));

/** Supersedes the current grant and inserts its successor, advancing the revision. */
const renewStoredUploadGrant = async (
  transaction: RequestDatabaseTransaction,
  input: Readonly<{
    fileId: FileId;
    expectedRevision: number;
    previousOneTimeId: PlatformId;
    grant: UploadGrant;
  }>,
): Promise<
  | Readonly<{ outcome: "renewed" }>
  | Readonly<{
      outcome: "refused";
      reason: Exclude<FileUploadRenewalRefusalReason, "field_not_writable" | "malformed_request">;
    }>
> => storedRenewalSchema.parse(await callUploadOperation(transaction, "renew", input));

/**
 * Marks the current, unexpired grant of a pending upload as having issued its one Storage
 * credential. A superseded, expired or already used grant returns null.
 */
const claimStoredUploadGrant = async (
  transaction: RequestDatabaseTransaction,
  oneTimeId: PlatformId,
): Promise<ClaimedUploadGrant | null> =>
  claimedUploadGrantSchema
    .nullable()
    .parse(await callUploadOperation(transaction, "claim", { oneTimeId }));

/**
 * Records the inspected metadata and safety result of a pending upload, leaving it scanning
 * (clean) or quarantined, and supersedes its grants.
 */
const recordStoredUploadOutcome = async (
  transaction: RequestDatabaseTransaction,
  input: Readonly<{ fileId: FileId; expectedRevision: number; fileRecord: FileRecord }>,
): Promise<
  | Readonly<{ outcome: "recorded"; fileRecord: FileRecord }>
  | Readonly<{
      outcome: "refused";
      reason: Exclude<
        FileUploadCompletionRefusalReason,
        "field_not_writable" | "upload_incomplete"
      >;
    }>
> => storedCompletionSchema.parse(await callUploadOperation(transaction, "complete", input));

export type UploadedObjectLocation = Readonly<{
  organizationId: OrganizationId;
  fileId: FileId;
  bucketId: typeof PRIVATE_FILE_BUCKET;
  objectPath: string;
}>;

/**
 * Trusted server-side inspection of the stored bytes, reading the exact pending
 * object through the bridge's `inspect` credential. Returns null while the object
 * has not been fully stored.
 */
export type UploadedObjectInspector = (
  location: UploadedObjectLocation,
) => Promise<TrustedFileInspection | null>;

export type FileUploadCoordinatorDependencies = Readonly<{
  transaction: RequestDatabaseTransaction;
  bridge: StorageCredentialBridge;
  inspectUploadedObject: UploadedObjectInspector;
  clock?: () => Date;
}>;

export type FileUploadAdmissionInput = CurrentUploadAuthority &
  Readonly<{
    organizationId: OrganizationId;
    applicationRootId?: ApplicationRootId;
    fieldId: FieldId;
    attachmentSettings: UploadAttachmentSettings;
    /**
     * Files the saved record currently holds in this field, from the Record
     * service. Used only to refuse early; the store counts the field itself.
     */
    existingAttachmentCount: number;
    replacingFileId?: FileId | undefined;
    /** Browser-supplied values: used only to refuse early, never to accept content. */
    rawFilename: string;
    claimedSizeBytes: number;
    claimedMediaType?: string;
    ttlSeconds?: number;
  }>;

export type FileUploadAdmissionResult =
  | Readonly<{
      outcome: "admitted";
      fileId: FileId;
      uploadGrant: UploadGrant;
      browserUploadGrant: BrowserUploadGrant;
      uploadExpiresAt: string;
      fileRecord: FileRecord;
    }>
  | Readonly<{ outcome: "refused"; reason: FileUploadAdmissionRefusalReason; message: string }>;

export type FileUploadRenewalInput = CurrentUploadAuthority &
  Readonly<{
    fileId: FileId;
    /** The current grant being renewed. */
    oneTimeId: PlatformId;
    ttlSeconds?: number;
  }>;

export type FileUploadRenewalResult =
  | Readonly<{
      outcome: "renewed";
      fileId: FileId;
      uploadGrant: UploadGrant;
      browserUploadGrant: BrowserUploadGrant;
      uploadExpiresAt: string;
    }>
  | Readonly<{ outcome: "refused"; reason: FileUploadRenewalRefusalReason; message: string }>;

export type FileUploadCompletionInput = CurrentUploadAuthority &
  Readonly<{
    fileId: FileId;
    attachmentSettings: UploadAttachmentSettings;
  }>;

export type FileUploadCompletionResult =
  | Readonly<{ outcome: "scanned"; fileRecord: FileRecord }>
  | Readonly<{
      outcome: "quarantined";
      fileRecord: FileRecord;
      scannerResult: "quarantined" | "refused";
    }>
  | Readonly<{ outcome: "refused"; reason: FileUploadCompletionRefusalReason; message: string }>;

export type FileUploadCoordinator = Readonly<{
  admitUpload(input: FileUploadAdmissionInput): Promise<FileUploadAdmissionResult>;
  renewUpload(input: FileUploadRenewalInput): Promise<FileUploadRenewalResult>;
  completeUpload(input: FileUploadCompletionInput): Promise<FileUploadCompletionResult>;
}>;

const REFUSAL_MESSAGES = {
  caller_not_authorized: "The caller cannot upload to this file",
  field_not_writable: "The attachment field is not changeable under current authority",
  field_capacity_exceeded: "The attachment field already holds its maximum number of files",
  file_size_exceeded: "The file is larger than the attachment field allows",
  disallowed_extension: "The file name's extension is not accepted by the attachment field",
  executable_content_refused: "Executable content is refused by platform safety policy",
  replacement_file_not_found: "The file being replaced is not a current attachment of this field",
  malformed_request: "The upload request is malformed",
  file_not_found: "The upload was not found",
  invalid_lifecycle_state: "The upload is not in a state that allows this step",
  grant_mismatch: "The upload grant is not the current grant for this upload",
  upload_expired: "The upload has expired",
  upload_incomplete: "The uploaded object has not been fully stored",
  revision_conflict: "The upload changed concurrently; read it again and retry",
  owner_mismatch: "The upload belongs to a different record or attachment field",
} as const satisfies Record<string, string>;

type RefusalReason = keyof typeof REFUSAL_MESSAGES;

const refuse = <Reason extends RefusalReason>(reason: Reason) =>
  Object.freeze({ outcome: "refused" as const, reason, message: REFUSAL_MESSAGES[reason] });

const defaultClock = () => new Date();

const isSameActor = (left: VerifiedFileActor, right: VerifiedFileActor): boolean =>
  left.kind === "human" && right.kind === "human"
    ? left.organizationAccountId === right.organizationAccountId &&
      left.identityId === right.identityId
    : left.kind === "system" &&
      right.kind === "system" &&
      left.systemActorId === right.systemActorId;

const maximumFileBytes = (settings: UploadAttachmentSettings): number =>
  Math.floor(settings.maxFileSizeMb * 1024 * 1024);

const maximumFiles = (settings: UploadAttachmentSettings): number =>
  settings.multiple ? (settings.maxFiles ?? 0) : 1;

const areUsableSettings = (settings: UploadAttachmentSettings | undefined): boolean =>
  settings !== undefined &&
  settings !== null &&
  Array.isArray(settings.allowedKinds) &&
  settings.allowedKinds.length > 0 &&
  (settings.allowedExtensions === undefined ||
    (Array.isArray(settings.allowedExtensions) &&
      settings.allowedExtensions.every((extension) => typeof extension === "string"))) &&
  Number.isFinite(settings.maxFileSizeMb) &&
  maximumFileBytes(settings) >= 1 &&
  typeof settings.multiple === "boolean" &&
  (settings.multiple
    ? Number.isSafeInteger(settings.maxFiles) && (settings.maxFiles ?? 0) >= 1
    : settings.maxFiles === undefined);

/** The extension of an already sanitised display name, or undefined when it has none. */
const displayNameExtension = (displayName: string): string | undefined => {
  const index = displayName.lastIndexOf(".");
  if (index <= 0 || index === displayName.length - 1) return undefined;
  const extension = normalizeFileExtension(displayName.slice(index));
  return /^\.[a-z0-9]+$/.test(extension) ? extension : undefined;
};

const isAllowedExtension = (settings: UploadAttachmentSettings, extension: string): boolean =>
  settings.allowedExtensions === undefined ||
  settings.allowedExtensions.length === 0 ||
  settings.allowedExtensions.map(normalizeFileExtension).includes(extension);

const grantLifetimeSeconds = (ttlSeconds: number | undefined): number | undefined => {
  if (ttlSeconds === undefined) return MAXIMUM_FILE_STORAGE_OPERATION_SECONDS;
  return Number.isSafeInteger(ttlSeconds) &&
    ttlSeconds >= 1 &&
    ttlSeconds <= MAXIMUM_FILE_STORAGE_OPERATION_SECONDS
    ? ttlSeconds
    : undefined;
};

const buildUploadGrant = (
  input: Readonly<{
    organizationId: OrganizationId;
    actor: VerifiedFileActor;
    owner: AttachmentOwner;
    fileId: FileId;
    maximumBytes: number;
    expiresAt: string;
    oneTimeId: PlatformId;
  }>,
): UploadGrant => {
  const policyFingerprint: Fingerprint = fingerprintSchema.parse(
    `sha256:${createHash("sha256")
      .update(
        JSON.stringify([
          "vortex:file:upload-grant",
          input.organizationId,
          input.owner.recordTypeId,
          input.owner.recordId,
          input.owner.fieldId,
          input.fileId,
          input.actor,
          input.maximumBytes,
          input.expiresAt,
          input.oneTimeId,
        ]),
        "utf8",
      )
      .digest("hex")}`,
  );
  return uploadGrantSchema.parse({
    kind: "upload",
    organizationId: input.organizationId,
    actor: input.actor,
    recordTypeId: input.owner.recordTypeId,
    recordId: input.owner.recordId,
    fieldId: input.owner.fieldId,
    maximumBytes: input.maximumBytes,
    policyFingerprint,
    expiresAt: input.expiresAt,
    oneTimeId: input.oneTimeId,
  });
};

const sameUploadGrant = (left: UploadGrant, right: UploadGrant): boolean =>
  sameId(left.organizationId, right.organizationId) &&
  isSameActor(left.actor, right.actor) &&
  sameId(left.recordTypeId, right.recordTypeId) &&
  sameId(left.recordId, right.recordId) &&
  sameId(left.fieldId, right.fieldId) &&
  left.maximumBytes === right.maximumBytes &&
  left.policyFingerprint === right.policyFingerprint &&
  sameId(left.oneTimeId, right.oneTimeId) &&
  Date.parse(left.expiresAt) === Date.parse(right.expiresAt);

/**
 * Current authority to continue an admitted upload: the request actor must be
 * the file's own organisation's verified uploader, and the owning attachment
 * field must still be changeable on the file's own record under the request's
 * current Access resolution.
 */
const authorizeUploader = (
  state: PendingUploadState,
  authority: CurrentUploadAuthority,
):
  | Readonly<{ authorized: true }>
  | Readonly<{ authorized: false; reason: "caller_not_authorized" | "field_not_writable" }> => {
  const actor = resolveVerifiedFileActor(authority.sessionContext, state.fileRecord.organizationId);
  if (
    !actor.authorized ||
    !isSameActor(actor.actor, state.uploader) ||
    !isSameActor(state.uploader, state.fileRecord.uploadedBy)
  ) {
    return { authorized: false, reason: "caller_not_authorized" };
  }
  // Field permissions granted on some other record say nothing about this file.
  const fieldId = state.fileRecord.ownerFieldId;
  if (
    fieldId === undefined ||
    !sameId(state.fileRecord.ownerRecordTypeId, authority.recordTypeId) ||
    state.fileRecord.ownerRecordId !== authority.recordId ||
    !verifyAttachmentFieldAuthority({
      fieldId,
      readableFieldIds: authority.readableFieldIds,
      changeableFieldIds: authority.changeableFieldIds,
      operation: "write",
    }).authorized
  ) {
    return { authorized: false, reason: "field_not_writable" };
  }
  return { authorized: true };
};

const isOpen = (state: PendingUploadState, now: Date): boolean =>
  now.getTime() < Date.parse(state.uploadExpiresAt);

const objectLocation = (fileRecord: FileRecord): UploadedObjectLocation =>
  Object.freeze({
    organizationId: fileRecord.organizationId,
    fileId: fileRecord.fileId,
    bucketId: fileRecord.bucketId,
    objectPath: fileRecord.storageKey,
  });

/**
 * Admits one upload. After current record/field authority and the field's
 * canonical settings accept the request, its pending metadata and first grant
 * are persisted before any bytes are accepted. The browser receives only a
 * short-lived INSERT credential for that pending object.
 */
export const reservePendingUpload = async (
  dependencies: FileUploadCoordinatorDependencies,
  input: FileUploadAdmissionInput,
): Promise<FileUploadAdmissionResult> => {
  const now = (dependencies.clock ?? defaultClock)();
  const ttlSeconds = grantLifetimeSeconds(input.ttlSeconds);
  const settings = input.attachmentSettings;
  if (
    ttlSeconds === undefined ||
    !Number.isSafeInteger(input.claimedSizeBytes) ||
    input.claimedSizeBytes < 0 ||
    !Number.isSafeInteger(input.existingAttachmentCount) ||
    input.existingAttachmentCount < 0 ||
    !areUsableSettings(settings)
  ) {
    return refuse("malformed_request");
  }

  const actorResolution = resolveVerifiedFileActor(input.sessionContext, input.organizationId);
  if (!actorResolution.authorized) return refuse("caller_not_authorized");
  const uploader = actorResolution.actor;

  const fieldAuthority = verifyAttachmentFieldAuthority({
    fieldId: input.fieldId,
    readableFieldIds: input.readableFieldIds,
    changeableFieldIds: input.changeableFieldIds,
    operation: "write",
  });
  if (!fieldAuthority.authorized) return refuse("field_not_writable");

  // Browser-supplied values can only refuse early here; completion decides from
  // the stored bytes.
  const displayName = sanitizeFileDisplayName(input.rawFilename);
  const extension = displayNameExtension(displayName);
  if (extension === undefined) return refuse("disallowed_extension");
  if (isExecutableContent(input.claimedMediaType ?? "", extension)) {
    return refuse("executable_content_refused");
  }
  if (!isAllowedExtension(settings, extension)) return refuse("disallowed_extension");
  if (input.claimedSizeBytes > maximumFileBytes(settings)) return refuse("file_size_exceeded");

  if (input.replacingFileId !== undefined && input.existingAttachmentCount < 1) {
    return refuse("replacement_file_not_found");
  }
  const remainingCount =
    input.replacingFileId === undefined
      ? input.existingAttachmentCount
      : input.existingAttachmentCount - 1;
  if (remainingCount >= maximumFiles(settings)) return refuse("field_capacity_exceeded");

  const fileId = fileIdSchema.parse(randomUUID());
  const oneTimeId = platformIdSchema.parse(randomUUID());
  const owner: AttachmentOwner = {
    recordTypeId: input.recordTypeId,
    ...(input.recordId === undefined ? {} : { recordId: input.recordId }),
    fieldId: input.fieldId,
  };
  const maximumBytes = Math.max(1, input.claimedSizeBytes);
  const uploadExpiresAt = new Date(
    now.getTime() + PENDING_UPLOAD_WINDOW_SECONDS * 1_000,
  ).toISOString();

  const pendingRecord = fileRecordSchema.safeParse({
    fileId,
    organizationId: input.organizationId,
    ...(input.applicationRootId === undefined
      ? {}
      : { applicationRootId: input.applicationRootId }),
    lifecycleState: "pending",
    originalSafeDisplayName: displayName,
    detectedMediaType: PENDING_MEDIA_TYPE,
    extension,
    sizeBytes: 0,
    checksum: PENDING_CHECKSUM,
    storageKey: createUnguessableStorageKey(input.organizationId, fileId),
    bucketId: PRIVATE_FILE_BUCKET,
    scannerName: PREFLIGHT_SCANNER_NAME,
    scannerVersion: PREFLIGHT_SCANNER_VERSION,
    scannerResult: "pending",
    previewReferences: [],
    uploadedBy: uploader,
    createdAt: now.toISOString(),
    owningAttachmentReferences: [],
    ownerRecordTypeId: owner.recordTypeId,
    ownerRecordId: owner.recordId,
    ownerFieldId: owner.fieldId,
    legalHold: { isHeld: false },
  });
  if (!pendingRecord.success) return refuse("malformed_request");

  const uploadGrant = buildUploadGrant({
    organizationId: input.organizationId,
    actor: uploader,
    owner,
    fileId,
    maximumBytes,
    expiresAt: new Date(now.getTime() + ttlSeconds * 1_000).toISOString(),
    oneTimeId,
  });

  const reserved = await reserveStoredUpload(dependencies.transaction, {
    fileRecord: pendingRecord.data,
    grant: uploadGrant,
    correlationId: input.sessionContext.correlationId,
    uploadExpiresAt,
    ...(input.replacingFileId === undefined ? {} : { replacingFileId: input.replacingFileId }),
    existingAttachmentCount: input.existingAttachmentCount,
    maxFiles: maximumFiles(settings),
  });
  if (reserved.outcome === "refused") return refuse(reserved.reason);
  const fileRecord = fileRecordSchema.parse(reserved.fileRecord);
  if (
    fileRecord.fileId !== fileId ||
    fileRecord.storageKey !== pendingRecord.data.storageKey ||
    fileRecord.lifecycleState !== "pending"
  )
    throw new Error("FILE_UPLOAD_RESERVATION_INCONSISTENT");
  const browserUploadGrant = await dependencies.bridge.mintBrowserUploadGrant({
    request: { operation: "upload", grant: uploadGrant },
    ttlSeconds,
  });
  return Object.freeze({
    outcome: "admitted" as const,
    fileId,
    uploadGrant,
    browserUploadGrant,
    uploadExpiresAt,
    fileRecord,
  });
};

/**
 * Renews the browser credential of an in-progress resumable upload. Renewal
 * repeats File admission with current authority: only the uploader, still able to
 * change the owning field, may replace the upload's current grant, and only while
 * the upload is pending inside its window. The previous grant is superseded.
 */
export const renewPendingUpload = async (
  dependencies: FileUploadCoordinatorDependencies,
  input: FileUploadRenewalInput,
): Promise<FileUploadRenewalResult> => {
  const now = (dependencies.clock ?? defaultClock)();
  const ttlSeconds = grantLifetimeSeconds(input.ttlSeconds);
  if (ttlSeconds === undefined) return refuse("malformed_request");

  const state = await readStoredPendingUpload(dependencies.transaction, input.fileId);
  if (state === null) return refuse("file_not_found");

  const authority = authorizeUploader(state, input);
  if (!authority.authorized) return refuse(authority.reason);

  const fileRecord = state.fileRecord;
  if (fileRecord.lifecycleState !== "pending") return refuse("invalid_lifecycle_state");
  if (!isOpen(state, now)) return refuse("upload_expired");
  if (!sameId(state.currentGrantId, input.oneTimeId)) return refuse("grant_mismatch");
  if (
    fileRecord.ownerRecordTypeId === undefined ||
    fileRecord.ownerRecordId === undefined ||
    fileRecord.ownerFieldId === undefined
  ) {
    return refuse("invalid_lifecycle_state");
  }

  const expiresAtMilliseconds = Math.min(
    now.getTime() + ttlSeconds * 1_000,
    Date.parse(state.uploadExpiresAt),
  );
  const renewedGrant = buildUploadGrant({
    organizationId: fileRecord.organizationId,
    actor: state.uploader,
    owner: {
      recordTypeId: fileRecord.ownerRecordTypeId,
      recordId: fileRecord.ownerRecordId,
      fieldId: fileRecord.ownerFieldId,
    },
    fileId: fileRecord.fileId,
    maximumBytes: state.maximumBytes,
    expiresAt: new Date(expiresAtMilliseconds).toISOString(),
    oneTimeId: platformIdSchema.parse(randomUUID()),
  });

  const renewed = await renewStoredUploadGrant(dependencies.transaction, {
    fileId: fileRecord.fileId,
    expectedRevision: state.revision,
    previousOneTimeId: input.oneTimeId,
    grant: renewedGrant,
  });
  if (renewed.outcome === "refused") return refuse(renewed.reason);

  const browserUploadGrant = await dependencies.bridge.mintBrowserUploadGrant({
    request: { operation: "upload", grant: renewedGrant },
    ttlSeconds,
  });

  return Object.freeze({
    outcome: "renewed" as const,
    fileId: fileRecord.fileId,
    uploadGrant: renewedGrant,
    browserUploadGrant,
    uploadExpiresAt: state.uploadExpiresAt,
  });
};

type ContentDecision =
  Readonly<{ outcome: "clean" }> | Readonly<{ outcome: "quarantined" | "refused" }>;

/**
 * Applies the field's canonical settings to what inspection found in the stored
 * bytes. The detected content decides; the file name's extension must agree with
 * it and with the field, and the bytes may not exceed the admitted reservation.
 */
const decideInspectedContent = (
  inspection: TrustedFileInspection,
  nameExtension: string,
  maximumBytes: number,
  settings: UploadAttachmentSettings,
): ContentDecision => {
  const detectedExtension = normalizeFileExtension(inspection.detectedExtension);
  if (
    isExecutableContent(inspection.detectedMediaType, nameExtension) ||
    isExecutableContent(inspection.detectedMediaType, detectedExtension) ||
    inspection.actualSizeBytes > maximumBytes
  ) {
    return { outcome: "refused" };
  }

  const safety = verifyContentSafety({
    detectedMediaType: inspection.detectedMediaType,
    extension: nameExtension,
    sizeBytes: inspection.actualSizeBytes,
    // Field cardinality was reserved at admission and is enforced again by the
    // record save; this check is about the content alone.
    existingAttachmentCount: 0,
    allowedKinds: settings.allowedKinds,
    ...(settings.allowedExtensions === undefined
      ? {}
      : { allowedExtensions: settings.allowedExtensions }),
    maxFileSizeMb: settings.maxFileSizeMb,
    multiple: settings.multiple,
    ...(settings.maxFiles === undefined ? {} : { maxFiles: settings.maxFiles }),
  });
  if (!safety.accepted) return { outcome: safety.outcome };

  // An extension the platform cannot vouch for must name what the bytes are.
  if (
    nameExtension !== detectedExtension &&
    expectedContentKindsForExtension(nameExtension) === undefined
  ) {
    return { outcome: "quarantined" };
  }
  return { outcome: "clean" };
};

const completionOf = (fileRecord: FileRecord): FileUploadCompletionResult =>
  fileRecord.lifecycleState === "quarantined"
    ? {
        outcome: "quarantined",
        fileRecord,
        scannerResult: fileRecord.scannerResult === "refused" ? "refused" : "quarantined",
      }
    : { outcome: "scanned", fileRecord };

/**
 * Completes an upload from its stored bytes. After rechecking the uploader's
 * current authority, trusted inspection supplies the actual size, detected media
 * type, content extension and checksum; the field settings and content inspection then leave the file scanning with a clean result, ready for the record
 * save that activates it, or quarantine it (refused content included). Browser
 * metadata plays no part. A repeated completion returns the recorded result.
 */
export const completeFileUpload = async (
  dependencies: FileUploadCoordinatorDependencies,
  input: FileUploadCompletionInput,
): Promise<FileUploadCompletionResult> => {
  const now = (dependencies.clock ?? defaultClock)();
  const settings = input.attachmentSettings;
  if (!areUsableSettings(settings)) {
    throw new Error("FILE_UPLOAD_ATTACHMENT_SETTINGS_INVALID");
  }

  const state = await readStoredPendingUpload(dependencies.transaction, input.fileId);
  if (state === null) return refuse("file_not_found");

  const authority = authorizeUploader(state, input);
  if (!authority.authorized) return refuse(authority.reason);

  const fileRecord = state.fileRecord;
  if (
    fileRecord.lifecycleState === "quarantined" ||
    (fileRecord.lifecycleState === "scanning" && fileRecord.scannerResult === "clean")
  ) {
    return completionOf(fileRecord);
  }
  if (fileRecord.lifecycleState !== "pending") return refuse("invalid_lifecycle_state");
  if (!isOpen(state, now)) return refuse("upload_expired");

  const location = objectLocation(fileRecord);
  const inspected = await dependencies.inspectUploadedObject(location);
  if (inspected === null) return refuse("upload_incomplete");
  const inspection = trustedFileInspectionSchema.parse(inspected);

  const scanning = fileRecordSchema.parse({
    ...transitionFileLifecycleState(
      transitionFileLifecycleState(fileRecord, "uploaded", { clock: () => now }),
      "scanning",
      { clock: () => now },
    ),
    detectedMediaType: inspection.detectedMediaType,
    sizeBytes: inspection.actualSizeBytes,
    checksum: inspection.checksum,
  });

  const decision = decideInspectedContent(
    inspection,
    fileRecord.extension,
    state.maximumBytes,
    settings,
  );
  const safetyResult = {
    scannerName: PREFLIGHT_SCANNER_NAME,
    scannerVersion: PREFLIGHT_SCANNER_VERSION,
    scannerResult: decision.outcome,
  };

  const recorded = await recordStoredUploadOutcome(dependencies.transaction, {
    fileId: fileRecord.fileId,
    expectedRevision: state.revision,
    fileRecord: recordFileSafetyResult(scanning, safetyResult),
  });
  if (recorded.outcome === "refused") return refuse(recorded.reason);

  const stored = fileRecordSchema.parse(recorded.fileRecord);
  if (
    stored.fileId !== fileRecord.fileId ||
    !(
      stored.lifecycleState === "quarantined" ||
      (stored.lifecycleState === "scanning" && stored.scannerResult === "clean")
    )
  ) {
    throw new Error("FILE_UPLOAD_OUTCOME_INCONSISTENT");
  }
  return completionOf(stored);
};

/**
 * Activates a clean scanned upload inside the authorised record save that
 * attaches it. Trusted wiring calls this in the save's own transaction, after the
 * save's current Access resolution, so the activation and the field value commit
 * or roll back together. The uploader's current authority is rechecked; a still
 * valid upload credential grants nothing here. A replacement never touches the
 * file it replaces: that attachment stays current until this save commits, and
 * the save's own detachment then retires it through the ordinary lifecycle.
 */
/**
 * The Storage credential bridge's authority for upload-side operations. An
 * upload credential is issued once per current, unexpired grant of a pending
 * upload; an inspect credential only for a pending upload inside its window.
 * Trusted wiring composes this with the read and delete resolvers; any other
 * operation is refused here.
 */
export const createUploadStorageAuthorityResolver = (
  transaction: RequestDatabaseTransaction,
  clock: () => Date = defaultClock,
): ResolveCurrentStorageAuthority => {
  return async (request) => {
    const now = clock().getTime();
    switch (request.operation) {
      case "upload": {
        const requested = uploadGrantSchema.safeParse(request.grant);
        if (!requested.success) return { authorized: false };
        const claimed = await claimStoredUploadGrant(transaction, requested.data.oneTimeId);
        if (claimed === null) return { authorized: false };
        const grant = uploadGrantSchema.safeParse(claimed.grant);
        const fileRecord = fileRecordSchema.safeParse(claimed.fileRecord);
        if (
          !grant.success ||
          !fileRecord.success ||
          !sameUploadGrant(grant.data, requested.data) ||
          fileRecord.data.lifecycleState !== "pending" ||
          !(now < Date.parse(grant.data.expiresAt))
        ) {
          return { authorized: false };
        }
        return {
          authorized: true,
          operation: "upload",
          organizationId: fileRecord.data.organizationId,
          fileId: fileRecord.data.fileId,
          fileRecord: fileRecord.data,
          actor: grant.data.actor,
          correlationId: claimed.correlationId,
          validUntil: grant.data.expiresAt,
          transferGrantId: grant.data.oneTimeId,
        };
      }
      case "inspect": {
        const state = await readStoredPendingUpload(transaction, request.fileId);
        if (
          state === null ||
          state.fileRecord.lifecycleState !== "pending" ||
          !(now < Date.parse(state.uploadExpiresAt))
        ) {
          return { authorized: false };
        }
        return {
          authorized: true,
          operation: "inspect",
          organizationId: state.fileRecord.organizationId,
          fileId: state.fileRecord.fileId,
          fileRecord: state.fileRecord,
          actor: state.uploader,
          correlationId: state.correlationId,
          validUntil: state.uploadExpiresAt,
        };
      }
      default:
        return { authorized: false };
    }
  };
};

/**
 * Composes current attachment authority, field settings, admission,
 * the Storage credential bridge, trusted inspection and content inspection into one
 * upload lifecycle: admit, renew, complete, and activate in the record save.
 */
export const createFileUploadCoordinator = (
  dependencies: FileUploadCoordinatorDependencies,
): FileUploadCoordinator =>
  Object.freeze({
    admitUpload: (input) => reservePendingUpload(dependencies, input),
    renewUpload: (input) => renewPendingUpload(dependencies, input),
    completeUpload: (input) => completeFileUpload(dependencies, input),
  });
