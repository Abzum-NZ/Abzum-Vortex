import "server-only";

import { randomUUID } from "node:crypto";
import {
  PRIVATE_FILE_BUCKET,
  fileRecordSchema,
  type ApplicationRootId,
  type FieldId,
  type FileId,
  type FileLifecycleState,
  type FileRecord,
  type Fingerprint,
  type OrganizationId,
  type PlatformId,
  type RecordId,
  type RecordTypeId,
  type VerifiedFileActor,
} from "@vortex/contracts";
import { createUnguessableStorageKey } from "./storage-policy";
import {
  normalizeFileExtension,
  verifyContentSafety,
  type ContentKind,
} from "./content-safety";

/** The preflight safety check this module performs before any external scanner runs. */
export const PREFLIGHT_SCANNER_NAME = "vortex_file_preflight";
export const PREFLIGHT_SCANNER_VERSION = "1";

/**
 * Turns an untrusted file name into a safe display name. Directory prefixes,
 * traversal, control characters and shell/path metacharacters are removed, and the
 * result is bounded to the 255 characters the file contract stores. The display
 * name is metadata only; it never becomes part of a storage path.
 */
export const sanitizeFileDisplayName = (
  rawFilename: string,
  fallbackExtension = "",
): string => {
  const fallback = `unnamed_file${fallbackExtension}`;
  if (typeof rawFilename !== "string" || rawFilename.trim().length === 0) {
    return fallback;
  }

  const basename = rawFilename.split(/[/\\]/).pop() ?? rawFilename;

  const sanitized = basename
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim();

  if (sanitized.length === 0 || /^\.+$/.test(sanitized)) {
    return fallback;
  }

  if (sanitized.length > 255) {
    const extensionIndex = sanitized.lastIndexOf(".");
    if (extensionIndex > 0 && extensionIndex > sanitized.length - 20) {
      const extension = sanitized.slice(extensionIndex);
      return `${sanitized.slice(0, 255 - extension.length)}${extension}`;
    }
    return sanitized.slice(0, 255);
  }

  return sanitized;
};

/** The canonical file lifecycle of the files specification. */
const ALLOWED_LIFECYCLE_TRANSITIONS: ReadonlyMap<
  FileLifecycleState,
  ReadonlySet<FileLifecycleState>
> = new Map([
  ["pending", new Set<FileLifecycleState>(["uploaded", "abandoned"])],
  ["uploaded", new Set<FileLifecycleState>(["scanning", "abandoned"])],
  ["scanning", new Set<FileLifecycleState>(["active", "quarantined"])],
  ["active", new Set<FileLifecycleState>(["soft_deleted"])],
  ["quarantined", new Set<FileLifecycleState>(["removed"])],
  ["abandoned", new Set<FileLifecycleState>(["removed"])],
  ["soft_deleted", new Set<FileLifecycleState>(["active", "removed"])],
  ["removed", new Set<FileLifecycleState>()],
]);

export const isValidFileLifecycleTransition = (
  from: FileLifecycleState,
  to: FileLifecycleState,
): boolean => ALLOWED_LIFECYCLE_TRANSITIONS.get(from)?.has(to) === true;

/**
 * Moves one file to its next lifecycle state. Illegal transitions are refused, a
 * file only becomes active once its safety result is clean, activation and deletion
 * times are recorded, and restoring inside the recovery period clears the deletion
 * time the soft deletion set.
 */
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

  if (nextState === "active" && fileRecord.scannerResult !== "clean") {
    throw new Error(
      `Refusing to activate file ${fileRecord.fileId}: its safety result is '${fileRecord.scannerResult}'`,
    );
  }

  const clock = options?.clock ?? (() => new Date());
  const nowIso = clock().toISOString();

  if (nextState === "active") {
    // Restoring inside the recovery period clears the deletion the soft delete recorded.
    const { deletedAt, ...restored } = fileRecord;
    return fileRecordSchema.parse({
      ...restored,
      lifecycleState: nextState,
      activatedAt: fileRecord.activatedAt ?? nowIso,
    });
  }

  return fileRecordSchema.parse({
    ...fileRecord,
    lifecycleState: nextState,
    ...(nextState === "soft_deleted" ? { deletedAt: nowIso } : {}),
  });
};

/**
 * Records the outcome of the safety check on a file that is being scanned. A clean
 * result leaves the file scanning, ready for the activation the record save commits;
 * any other result quarantines it for review.
 */
export const recordFileSafetyResult = (
  fileRecord: FileRecord,
  outcome: Readonly<{
    scannerName: string;
    scannerVersion: string;
    scannerResult: "clean" | "quarantined" | "refused";
  }>,
): FileRecord => {
  if (fileRecord.lifecycleState !== "scanning") {
    throw new Error(
      `Refusing a safety result for file ${fileRecord.fileId}: it is '${fileRecord.lifecycleState}', not scanning`,
    );
  }

  return fileRecordSchema.parse({
    ...fileRecord,
    lifecycleState: outcome.scannerResult === "clean" ? "scanning" : "quarantined",
    scannerName: outcome.scannerName,
    scannerVersion: outcome.scannerVersion,
    scannerResult: outcome.scannerResult,
  });
};

/** The canonical attachment settings of the field contract. */
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
  owner?: Readonly<{
    recordTypeId: RecordTypeId;
    recordId: RecordId;
    fieldId: FieldId;
  }>;
  attachmentConstraints?: FileAttachmentConstraints;
  existingAttachmentCount: number;
  rawFilename: string;
  detectedMediaType: string;
  extension: string;
  sizeBytes: number;
  checksum: Fingerprint;
  uploader: VerifiedFileActor;
  fileId?: FileId;
  owningAttachmentReferences?: readonly PlatformId[];
  legalHold?: boolean;
  clock?: () => Date;
}>;

/**
 * Creates one private, organisation-owned file record: its owning record type,
 * record and attachment field, its safe display name, verified media type,
 * extension, size and checksum, its verified human or registered system uploader,
 * and its private bucket and organisation-scoped unguessable object path.
 *
 * The file starts pending. Executable content and settings the field cannot accept
 * are refused outright; content that disagrees with its name or with the field's
 * allowed kinds and extensions is created quarantined for review. Activation is a
 * later lifecycle transition that a clean safety result gates, so this function
 * never returns an active file.
 */
export const createFileRecord = (input: CreateFileRecordInput): FileRecord => {
  const clock = input.clock ?? (() => new Date());
  const nowIso = clock().toISOString();

  const normalizedExtension = normalizeFileExtension(input.extension);
  const safeDisplayName = sanitizeFileDisplayName(input.rawFilename, normalizedExtension);

  const safetyResult = verifyContentSafety({
    detectedMediaType: input.detectedMediaType,
    extension: normalizedExtension,
    sizeBytes: input.sizeBytes,
    existingAttachmentCount: input.existingAttachmentCount,
    ...(input.attachmentConstraints?.allowedKinds === undefined
      ? {}
      : { allowedKinds: input.attachmentConstraints.allowedKinds }),
    ...(input.attachmentConstraints?.allowedExtensions === undefined
      ? {}
      : { allowedExtensions: input.attachmentConstraints.allowedExtensions }),
    ...(input.attachmentConstraints?.maxFileSizeMb === undefined
      ? {}
      : { maxFileSizeMb: input.attachmentConstraints.maxFileSizeMb }),
    ...(input.attachmentConstraints?.multiple === undefined
      ? {}
      : { multiple: input.attachmentConstraints.multiple }),
    ...(input.attachmentConstraints?.maxFiles === undefined
      ? {}
      : { maxFiles: input.attachmentConstraints.maxFiles }),
  });

  if (!safetyResult.accepted && safetyResult.outcome === "refused") {
    throw new Error(`File metadata creation refused: ${safetyResult.reason}`);
  }

  const fileId = input.fileId ?? (randomUUID() as FileId);

  // Object paths are built from these identifiers, and a private path has one
  // canonical lowercase form, so a differently cased identifier is refused here
  // rather than producing a path the storage policy would later reject.
  if (
    input.organizationId !== input.organizationId.toLowerCase() ||
    fileId !== fileId.toLowerCase()
  ) {
    throw new Error(
      "File metadata creation refused: organisation and file identifiers must be in their canonical lowercase form",
    );
  }

  const quarantined = !safetyResult.accepted;

  return fileRecordSchema.parse({
    fileId,
    organizationId: input.organizationId,
    ...(input.applicationRootId === undefined
      ? {}
      : { applicationRootId: input.applicationRootId }),
    lifecycleState: quarantined ? "quarantined" : "pending",
    originalSafeDisplayName: safeDisplayName,
    detectedMediaType: input.detectedMediaType,
    extension: normalizedExtension,
    sizeBytes: input.sizeBytes,
    checksum: input.checksum,
    storageKey: createUnguessableStorageKey(input.organizationId, fileId),
    bucketId: PRIVATE_FILE_BUCKET,
    scannerName: PREFLIGHT_SCANNER_NAME,
    scannerVersion: PREFLIGHT_SCANNER_VERSION,
    scannerResult: quarantined ? "quarantined" : "pending",
    previewReferences: [],
    uploadedBy: input.uploader,
    createdAt: nowIso,
    owningAttachmentReferences: [...(input.owningAttachmentReferences ?? [])],
    ...(input.owner === undefined
      ? {}
      : {
          ownerRecordTypeId: input.owner.recordTypeId,
          ownerRecordId: input.owner.recordId,
          ownerFieldId: input.owner.fieldId,
        }),
    legalHold: input.legalHold ?? false,
  });
};
