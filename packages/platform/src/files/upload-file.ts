import "server-only";
import { z } from "zod";
import { sessionContextSchema } from "../access/identity-access";
import {
  fieldIdSchema,
  applicationRootIdSchema,
  type RecordTypeId,
  type RecordId,
  type FieldId,
  type FileId,
} from "../catalogue/identifiers";
import { sameId } from "../catalogue/runtime-primitives";
import type { RequestDatabaseTransaction } from "../db/request-transaction";
import {
  createFileUploadCoordinator,
  createUploadStorageAuthorityResolver,
  readStoredPendingUpload,
} from "./upload";
import { createStorageCredentialBridge, type StorageKeyDefinition } from "./storage-credentials";
import { createStoredUploadInspection } from "./upload-inspection";
import { resolveFileStorageDestination, type FileStorageDestination } from "./storage-destination";

const settingsSchema = z
  .object({
    allowedKinds: z.array(
      z.enum([
        "image",
        "document",
        "spreadsheet",
        "presentation",
        "audio",
        "video",
        "archive",
        "text",
        "other",
      ]),
    ),
    allowedExtensions: z.array(z.string()).optional(),
    maxFileSizeMb: z.number().positive(),
    multiple: z.boolean(),
    maxFiles: z.number().int().optional(),
  })
  .strict();
const authoritySchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("refused") }).strict(),
  z
    .object({
      outcome: z.literal("allowed"),
      sessionContext: sessionContextSchema,
      attachmentSettings: settingsSchema,
      readableFieldIds: z.array(fieldIdSchema),
      changeableFieldIds: z.array(fieldIdSchema),
      existingAttachmentCount: z.number().int().nonnegative(),
    })
    .strict(),
]);
type Owner = Readonly<{
  recordTypeId: RecordTypeId;
  recordId?: RecordId | undefined;
  fieldId: FieldId;
}>;
type Configuration = Readonly<{ destination: FileStorageDestination; key: StorageKeyDefinition }>;
const refusal = {
  outcome: "refused" as const,
  message: "You cannot upload to this field. Refresh the page and try again.",
};
const uploadContext = async (
  transaction: RequestDatabaseTransaction,
  input: Owner,
  configuration: Configuration,
) => {
  const rows = await transaction.query<{
    result: unknown;
  }>`select vortex_record.read_attachment_upload_authority(${input.recordTypeId}::uuid,${input.recordId ?? null}::uuid,${input.fieldId}::uuid) as result`;
  if (rows.length !== 1) throw new Error("UPLOAD_AUTHORITY_RESULT_INVALID");
  const authority = authoritySchema.parse(rows[0]?.result);
  if (authority.outcome !== "allowed") return undefined;
  const bridge = createStorageCredentialBridge({
    destination: configuration.destination,
    activeKeyId: configuration.key.keyId,
    keys: [configuration.key],
    resolveCurrentAuthority: createUploadStorageAuthorityResolver(transaction),
  });
  return {
    authority,
    bridge,
    current: {
      sessionContext: authority.sessionContext,
      ...input,
      readableFieldIds: authority.readableFieldIds,
      changeableFieldIds: authority.changeableFieldIds,
    },
  };
};

/** Persists admission before returning a short-lived credential for exactly one new object. */
export const admitAttachmentUpload = async (
  transaction: RequestDatabaseTransaction,
  input: Owner &
    Readonly<{
      filename: string;
      mediaType: string;
      sizeBytes: number;
      replacingFileId?: FileId | undefined;
    }>,
  configuration: Configuration,
) => {
  const resolved = await uploadContext(transaction, input, configuration);
  if (resolved === undefined) return refusal;
  const { authority, bridge, current } = resolved;
  const context = authority.sessionContext;
  const coordinator = createFileUploadCoordinator({
    transaction,
    bridge,
    ...createStoredUploadInspection({
      bridge,
      destination: configuration.destination,
      maximumBytes: Math.max(1, input.sizeBytes),
    }),
  });
  const admitted = await coordinator.admitUpload({
    ...current,
    organizationId: context.organizationId,
    applicationRootId: applicationRootIdSchema.parse(context.applicationRootId),
    attachmentSettings: authority.attachmentSettings,
    existingAttachmentCount: authority.existingAttachmentCount,
    ...(input.replacingFileId === undefined ? {} : { replacingFileId: input.replacingFileId }),
    rawFilename: input.filename,
    claimedSizeBytes: input.sizeBytes,
    claimedMediaType: input.mediaType,
  });
  if (admitted.outcome !== "admitted") return admitted;
  const grant = admitted.browserUploadGrant;
  return {
    outcome: "admitted" as const,
    fileId: admitted.fileId,
    url: `${resolveFileStorageDestination(configuration.destination).origin}/storage/v1/object/${grant.bucketId}/${grant.objectPath.split("/").map(encodeURIComponent).join("/")}`,
    token: grant.token,
  };
};

/** Stored bytes decide kind and size. Only the record save can activate the reference. */
export const completeAttachmentUpload = async (
  transaction: RequestDatabaseTransaction,
  input: Owner & Readonly<{ fileId: FileId }>,
  configuration: Configuration,
) => {
  const resolved = await uploadContext(transaction, input, configuration);
  if (resolved === undefined) return refusal;
  const { authority, bridge, current } = resolved;
  const pending = await readStoredPendingUpload(transaction, input.fileId);
  if (
    pending === null ||
    !sameId(pending.fileRecord.ownerRecordTypeId, input.recordTypeId) ||
    !sameId(pending.fileRecord.ownerRecordId, input.recordId) ||
    !sameId(pending.fileRecord.ownerFieldId, input.fieldId)
  )
    return refusal;
  const coordinator = createFileUploadCoordinator({
    transaction,
    bridge,
    ...createStoredUploadInspection({
      bridge,
      destination: configuration.destination,
      maximumBytes: pending.maximumBytes,
    }),
  });
  const completed = await coordinator.completeUpload({
    ...current,
    fileId: input.fileId,
    attachmentSettings: authority.attachmentSettings,
  });
  if (completed.outcome === "refused") return completed;
  if (completed.outcome === "quarantined")
    return {
      outcome: "refused" as const,
      message: "This file's content is not allowed by the attachment field.",
    };
  return {
    outcome: "completed" as const,
    fileId: completed.fileRecord.fileId,
    name: completed.fileRecord.originalSafeDisplayName,
  };
};
