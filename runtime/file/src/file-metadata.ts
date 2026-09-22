import "server-only";

import { randomUUID } from "node:crypto";
import {
  fileRecordSchema,
  type ApplicationRootId,
  type FieldId,
  type FileId,
  type FileLifecycleState,
  type FileRecord,
  type FileUploaderActor,
  type Fingerprint,
  type OrganizationId,
  type PlatformId,
  type RecordId,
  type RecordTypeId,
} from "@vortex/contracts";
import {
  PRIVATE_STORAGE_BUCKET,
  createUnguessableStorageKey,
  validateStorageKey,
} from "./storage-policy";
import {
  verifyContentSafety,
  type ContentKind,
} from "./content-safety";

/**
 * Sanitizes an untrusted filename into a safe display name.
 * Strips path separators, directory traversal, null bytes, and non-printable control characters.
 * Enforces maximum length of 255 characters.
 */
export const sanitizeFileDisplayName = (
  rawFilename: string,
  fallbackExtension = "",
): string => {
  if (typeof rawFilename !== "string" || rawFilename.trim().length === 0) {
    return `unnamed_file${fallbackExtension}`;
  }

  // Remove directory prefixes and path traversals
  const basename = rawFilename.split(/[/\\]/).pop() ?? rawFilename;

  // Strip control characters, null bytes, and dangerous characters
  const sanitized = basename
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim();

  if (sanitized.length === 0 || sanitized === "." || sanitized === "..") {
    return `unnamed_file${fallbackExtension}`;
  }

  if (sanitized.length > 255) {
    const extIndex = sanitized.lastIndexOf(".");
    if (extIndex > 0 && extIndex > sanitized.length - 20) {
      const ext = sanitized.slice(extIndex);
      const stem = sanitized.slice(0, 255 - ext.length);
      return `${stem}${ext}`;
    }
    return sanitized.slice(0, 255);
  }

  return sanitized;
};

/** Canonical state transitions per specification file lifecycle diagram */
const ALLOWED_LIFECYCLE_TRANSITIONS: ReadonlyMap<
  FileLifecycleState,
  ReadonlySet<FileLifecycleState>
> = new Map([
  ["pending", new Set(["uploaded", "abandoned"])],
  ["uploaded", new Set(["scanning", "abandoned"])],
  ["scanning", new Set(["active", "quarantined"])],
  ["active", new Set(["soft_deleted"])],
  ["quarantined", new Set(["removed"])],
  ["abandoned", new Set(["removed"])],
  ["soft_deleted", new Set(["active", "removed"])],
  ["removed", new Set()],
]);

export const isValidFileLifecycleTransition = (
  from: FileLifecycleState,
  to: FileLifecycleState,
): boolean => {
  const allowed = ALLOWED_LIFECYCLE_TRANSITIONS.get(from);
  return allowed !== undefined && allowed.has(to);
};

export const transitionFileLifecycleState = (
  fileRecord: FileRecord,
  nextState: FileLifecycleState,
  options?: { clock?: () => Date },
): FileRecord => {
  if (!isValidFileLifecycleTransition(fileRecord.lifecycleState, nextState)) {
    throw new Error(
      `Illegal file lifecycle transition from '${fileRecord.lifecycleState}' to '${nextState}'`,
    );
  }

  const clock = options?.clock ?? (() => new Date());
  const nowIso = clock().toISOString();

  const updated: FileRecord = {
    ...fileRecord,
    lifecycleState: nextState,
    ...(nextState === "active" && !fileRecord.activatedAt
      ? { activatedAt: nowIso }
      : {}),
    ...(nextState === "soft_deleted" ? { deletedAt: nowIso } : {}),
  };

  return fileRecordSchema.parse(updated);
};

export type FileAttachmentConstraints = Readonly<{
  allowedKinds?: readonly ContentKind[];
  allowedExtensions?: readonly string[];
  maxFileSizeMb?: number;
  multiple?: boolean;
  maxFiles?: number;
}>;

export type CreateFileRecordInput = Readonly<{
  organizationId: OrganizationId;
  applicationRootId?: ApplicationRootId;
  ownerRecordTypeId?: RecordTypeId;
  ownerRecordId?: RecordId;
  ownerFieldId?: FieldId;
  attachmentConstraints?: FileAttachmentConstraints;
  rawFilename: string;
  detectedMediaType: string;
  extension: string;
  sizeBytes: number;
  checksum: Fingerprint;
  uploader: FileUploaderActor;
  fileId?: FileId;
  storageKey?: string;
  bucketId?: string;
  scannerName?: string;
  scannerVersion?: string;
  scannerResult?: "pending" | "clean" | "quarantined" | "refused";
  initialState?: FileLifecycleState;
  owningAttachmentReferences?: readonly PlatformId[];
  legalHold?: boolean;
  clock?: () => Date;
}>;

/**
 * Creates and validates a private organization-owned FileRecord.
 * Stores owner record/field, safe name, detected type, size, checksum, uploader,
 * and lifecycle state under organization-scoped unguessable object paths.
 * Enforces canonical attachment constraints and safety checks.
 */
export const createFileRecord = (
  input: CreateFileRecordInput,
): FileRecord => {
  const clock = input.clock ?? (() => new Date());
  const nowIso = clock().toISOString();

  // Normalize extension (must begin with dot and contain only lowercase alphanumeric)
  let normalizedExt = input.extension.toLowerCase().trim();
  if (!normalizedExt.startsWith(".")) {
    normalizedExt = `.${normalizedExt}`;
  }

  // Sanitize original display name
  const safeDisplayName = sanitizeFileDisplayName(
    input.rawFilename,
    normalizedExt,
  );

  // Content safety and canonical attachment settings verification
  const safetyResult = verifyContentSafety({
    detectedMediaType: input.detectedMediaType,
    extension: normalizedExt,
    sizeBytes: input.sizeBytes,
    allowedKinds: input.attachmentConstraints?.allowedKinds,
    allowedExtensions: input.attachmentConstraints?.allowedExtensions,
    maxFileSizeMb: input.attachmentConstraints?.maxFileSizeMb,
  });

  if (!safetyResult.accepted && safetyResult.outcome === "refused") {
    throw new Error(
      `File metadata creation refused: ${safetyResult.reason}`,
    );
  }

  const fileId = input.fileId ?? (randomUUID() as FileId);

  // Storage key must be organization-scoped and unguessable
  const storageKey =
    input.storageKey ?? createUnguessableStorageKey(input.organizationId, fileId);

  if (!validateStorageKey(storageKey, input.organizationId)) {
    throw new Error(
      `Invalid storage key for organization ${input.organizationId}: must start with organization ID and use unguessable format`,
    );
  }

  const scannerResult =
    safetyResult.outcome === "quarantined"
      ? "quarantined"
      : input.scannerResult ?? "pending";

  const lifecycleState =
    scannerResult === "quarantined"
      ? "quarantined"
      : input.initialState ?? "pending";

  const candidate = {
    fileId,
    organizationId: input.organizationId,
    ...(input.applicationRootId
      ? { applicationRootId: input.applicationRootId }
      : {}),
    lifecycleState,
    originalSafeDisplayName: safeDisplayName,
    detectedMediaType: input.detectedMediaType,
    extension: normalizedExt,
    sizeBytes: input.sizeBytes,
    checksum: input.checksum,
    storageKey,
    bucketId: input.bucketId ?? PRIVATE_STORAGE_BUCKET,
    scannerName: input.scannerName ?? "vortex_safety_preflight",
    scannerVersion: input.scannerVersion ?? "1.0.0",
    scannerResult,
    previewReferences: [],
    uploadedBy: input.uploader,
    createdAt: nowIso,
    ...(lifecycleState === "active" ? { activatedAt: nowIso } : {}),
    owningAttachmentReferences: input.owningAttachmentReferences
      ? [...input.owningAttachmentReferences]
      : [],
    ...(input.ownerRecordTypeId
      ? { ownerRecordTypeId: input.ownerRecordTypeId }
      : {}),
    ...(input.ownerRecordId ? { ownerRecordId: input.ownerRecordId } : {}),
    ...(input.ownerFieldId ? { ownerFieldId: input.ownerFieldId } : {}),
    legalHold: input.legalHold ?? false,
  };

  return fileRecordSchema.parse(candidate);
};
