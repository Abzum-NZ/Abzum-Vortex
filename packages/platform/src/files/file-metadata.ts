import "server-only";

import type {
  ApplicationRootId,
  FieldId,
  FileId,
  Fingerprint,
  OrganizationId,
  PlatformId,
  RecordId,
  RecordTypeId,
} from "../catalogue/identifiers";
import {
  fileRecordSchema,
  type FileLegalHoldProjection,
  type FileLifecycleState,
  type FileRecord,
  type VerifiedFileActor,
} from "./file-contracts";
import type { ContentKind } from "./content-safety";

/** The stored-content safety inspection used by upload completion. */
export const PREFLIGHT_SCANNER_NAME = "vortex_file_preflight";
export const PREFLIGHT_SCANNER_VERSION = "1";

/**
 * Turns an untrusted file name into a safe display name. Directory prefixes,
 * traversal, control characters and shell/path metacharacters are removed, and the
 * result is bounded to the 255 characters the file contract stores. The display
 * name is metadata only; it never becomes part of a storage path.
 */
export const sanitizeFileDisplayName = (rawFilename: string, fallbackExtension = ""): string => {
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
  ["scanning", new Set<FileLifecycleState>(["active", "quarantined", "abandoned"])],
  ["active", new Set<FileLifecycleState>(["soft_deleted"])],
  ["quarantined", new Set<FileLifecycleState>(["abandoned", "removed"])],
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
 * times are recorded, permanent removal clears derived/attachment references and
 * records its terminal time, and restoring inside the recovery period clears the
 * deletion time the soft deletion set.
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

  if (nextState === "removed") {
    return fileRecordSchema.parse({
      ...fileRecord,
      lifecycleState: nextState,
      previewReferences: [],
      owningAttachmentReferences: [],
      removedAt: nowIso,
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
  legalHold?: FileLegalHoldProjection;
  clock?: () => Date;
}>;
