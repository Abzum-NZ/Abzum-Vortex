import "server-only";

import { z } from "zod";
import { withRuntimeTransaction } from "../db/index";
import {
  correlationIdSchema,
  fileRecordSchema,
  platformIdSchema,
  timestampSchema,
} from "../schema";
import { createStorageCredentialBridge, type StorageKeyDefinition } from "./storage-credentials";
import { resolveFileStorageDestination, type FileStorageDestination } from "./storage-destination";

const claimSchema = z
  .object({
    fileRecord: fileRecordSchema,
    uploadExpiresAt: timestampSchema,
    correlationId: correlationIdSchema,
    claimId: platformIdSchema,
    validUntil: timestampSchema,
  })
  .strict();

/** Runs one bounded maintenance batch. Failed deletes retain their claim for retry after expiry. */
export const cleanupAbandonedUploads = async (
  configuration: Readonly<{
    destination: FileStorageDestination;
    key: StorageKeyDefinition;
  }>,
) => {
  const destination = resolveFileStorageDestination(configuration.destination);
  const claims = await withRuntimeTransaction(async (transaction) => {
    const rows = await transaction.query<{ result: unknown }>`
      select vortex_platform.claim_abandoned_file_uploads_internal(25,${destination.destinationProject}::text) as result`;
    if (rows.length !== 1) throw new Error("UPLOAD_CLEANUP_CLAIMS_INVALID");
    return z.array(claimSchema).max(25).parse(rows[0]?.result);
  });
  let removed = 0;
  let failed = 0;
  for (const claim of claims) {
    const file = claim.fileRecord;
    try {
      const bridge = createStorageCredentialBridge({
        destination: configuration.destination,
        activeKeyId: configuration.key.keyId,
        keys: [configuration.key],
        resolveCurrentAuthority: async (request) =>
          request.operation === "delete" && request.fileId === file.fileId
            ? {
                authorized: true,
                operation: "delete",
                organizationId: file.organizationId,
                fileId: file.fileId,
                fileRecord: file,
                actor: file.uploadedBy,
                correlationId: claim.correlationId,
                validUntil: claim.validUntil,
                abandonedUploadExpiresAt: claim.uploadExpiresAt,
              }
            : { authorized: false },
      });
      const credential = await bridge.mintStorageOperationCredential({
        request: { operation: "delete", fileId: file.fileId },
      });
      // Use Storage's deletion API: deleting storage.objects via SQL would orphan the bytes.
      // Removing an already-missing object is also successful, making crash recovery idempotent.
      const response = await fetch(
        `${credential.storageOrigin}/storage/v1/object/${credential.bucketId}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${credential.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ prefixes: [credential.objectPath] }),
          signal: AbortSignal.timeout(10_000),
          redirect: "error",
          cache: "no-store",
        },
      );
      if (!response.ok) throw new Error(`UPLOAD_CLEANUP_STORAGE_DELETE_FAILED:${response.status}`);
      await response.body?.cancel();
      const finished = await withRuntimeTransaction(async (transaction) => {
        const rows = await transaction.query<{ result: unknown }>`
          select vortex_platform.finish_abandoned_file_upload_internal(${file.fileId}::uuid,${claim.claimId}::uuid) as result`;
        if (rows.length !== 1) throw new Error("UPLOAD_CLEANUP_FINISH_INVALID");
        return z.boolean().parse(rows[0]?.result);
      });
      if (!finished) throw new Error("UPLOAD_CLEANUP_CLAIM_SUPERSEDED");
      removed += 1;
    } catch (cause) {
      console.error("UPLOAD_CLEANUP_FAILED", { fileId: file.fileId, cause });
      failed += 1;
    }
  }
  return { examined: claims.length, removed, failed };
};
