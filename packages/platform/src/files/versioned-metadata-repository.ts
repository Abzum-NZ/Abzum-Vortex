import "server-only";

import { fileIdSchema, fileRecordSchema, revisionSchema } from "@vortex/contracts";
import type { FileId } from "@vortex/contracts";
import { z } from "zod";
import type { FileRemovalRepository } from "./object-removal";
import type { FileReadSqlTransaction } from "./read-repository";

type SqlRow = Readonly<Record<string, unknown>>;

const versionedFileMetadataSnapshotSchema = z
  .object({
    revision: revisionSchema,
    fileRecord: fileRecordSchema,
  })
  .strict();

const invalidSnapshot = (): Error => new Error("FILE_METADATA_SNAPSHOT_INVALID");

const isObject = (value: unknown): value is SqlRow =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Reads the durable File metadata snapshot from one protected request
 * transaction. This adapter exposes only the snapshot port consumed by File
 * removal coordination; it does not establish removal eligibility or authority.
 */
export type VersionedFileMetadataRepository = Pick<
  FileRemovalRepository,
  "readFileSnapshot"
>;

export const createSqlVersionedFileMetadataRepository = (
  transaction: FileReadSqlTransaction,
): VersionedFileMetadataRepository => {
  const repository: VersionedFileMetadataRepository = {
    readFileSnapshot: async (fileId: FileId) => {
      const parsedFileId = fileIdSchema.safeParse(fileId);
      if (!parsedFileId.success) throw invalidSnapshot();

      const rows = await transaction.query<SqlRow>`
        select vortex_file.read_versioned_file_metadata(${parsedFileId.data}::uuid) as result
      `;
      const row = rows[0];
      if (
        rows.length !== 1 ||
        !isObject(row) ||
        Reflect.ownKeys(row).length !== 1 ||
        !Object.prototype.hasOwnProperty.call(row, "result")
      ) {
        throw invalidSnapshot();
      }

      if (row.result === null) return null;

      const parsedSnapshot = versionedFileMetadataSnapshotSchema.safeParse(row.result);
      if (
        !parsedSnapshot.success ||
        parsedSnapshot.data.fileRecord.fileId.toLowerCase() !==
          parsedFileId.data.toLowerCase()
      ) {
        throw invalidSnapshot();
      }

      return Object.freeze({
        revision: parsedSnapshot.data.revision,
        fileRecord: parsedSnapshot.data.fileRecord,
      });
    },
  };
  return Object.freeze(repository);
};
