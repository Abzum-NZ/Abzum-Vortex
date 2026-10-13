import "server-only";

import { z } from "zod";

import {
  applicationRootIdSchema,
  correlationIdSchema,
  downloadGrantSchema,
  fieldIdSchema,
  fileRecordSchema,
  organizationIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  type ApplicationRootId,
  type FieldId,
  type FileId,
  type FileRecord,
  type OrganizationId,
  type RecordId,
  type RecordTypeId,
} from "../schema";
import type { ClaimedDownloadGrant, FileReadRepository } from "./read";

type SqlValue = string | number | boolean | Date | Uint8Array | null;
type SqlRow = Readonly<Record<string, unknown>>;

/**
 * The Access-resolved protected request transaction, as `@vortex/db` provides
 * it. Every function below reads the request context that transaction
 * established, so it runs only inside the viewer's own protected request.
 */
export type FileReadSqlTransaction = Readonly<{
  query<Row extends SqlRow = SqlRow>(
    strings: TemplateStringsArray,
    ...values: readonly SqlValue[]
  ): Promise<readonly Row[]>;
}>;

type ResultRow = SqlRow & { result: unknown };

const singleResult = (rows: readonly ResultRow[]): unknown => {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("FILE_READ_RESULT_INVALID");
  return rows[0].result;
};

const asObject = (value: unknown): Readonly<Record<string, unknown>> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

const fileApplicationLocationSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("located"), applicationRootId: applicationRootIdSchema }).strict(),
  z.object({ outcome: z.literal("refused") }).strict(),
]);

const fileReadDecisionSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("allowed"),
      organizationId: organizationIdSchema,
      applicationRootId: applicationRootIdSchema,
      recordTypeId: recordTypeIdSchema,
      recordId: recordIdSchema,
      fieldId: fieldIdSchema,
    })
    .strict(),
  z.object({ outcome: z.literal("refused") }).strict(),
]);

const claimedDownloadGrantSchema = z
  .object({
    grant: downloadGrantSchema,
    fileRecord: fileRecordSchema,
    correlationId: correlationIdSchema,
  })
  .strict();

export type FileApplicationLocation =
  | Readonly<{ outcome: "located"; applicationRootId: ApplicationRootId }>
  | Readonly<{ outcome: "refused" }>;

/**
 * Locates the application of an active, attached file of the request
 * organisation, so the caller can open the application-scoped protected
 * request that a record read requires.
 */
export const locateFileApplication = async (
  transaction: FileReadSqlTransaction,
  fileId: FileId,
): Promise<FileApplicationLocation> => {
  return fileApplicationLocationSchema.parse(
    singleResult(
      await transaction.query<ResultRow>`
        select vortex_platform.read_file_application(${fileId}::uuid) as result
      `,
    ),
  );
};

export type FileReadDecision =
  | Readonly<{
      outcome: "allowed";
      organizationId: OrganizationId;
      applicationRootId: ApplicationRootId;
      recordTypeId: RecordTypeId;
      recordId: RecordId;
      fieldId: FieldId;
    }>
  | Readonly<{ outcome: "refused" }>;

/**
 * The viewer's current read decision for one file, from the protected record
 * read of its owning record and the attachment value that must still name it.
 */
export const decideFileRead = async (
  transaction: FileReadSqlTransaction,
  fileId: FileId,
): Promise<FileReadDecision> => {
  return fileReadDecisionSchema.parse(
    singleResult(
      await transaction.query<ResultRow>`
        select vortex_platform.decide_file_read(${fileId}::uuid) as result
      `,
    ),
  );
};

/**
 * The durable read-grant store over the `vortex_platform` download-grant
 * functions, bound to one protected request transaction.
 */
export const createSqlFileReadRepository = (
  transaction: FileReadSqlTransaction,
): FileReadRepository => {
  const repository: FileReadRepository = {
    readFile: async (fileId: FileId): Promise<FileRecord | null> => {
      const result = singleResult(
        await transaction.query<ResultRow>`
          select vortex_platform.read_file_for_download(${fileId}::uuid) as result
        `,
      );
      if (result === null) return null;
      return fileRecordSchema.parse(result);
    },
    recordDownloadGrant: async ({ grant, correlationId, purpose }) => {
      const result = asObject(
        singleResult(
          await transaction.query<ResultRow>`
            select vortex_platform.record_file_download_grant(
              ${grant.oneTimeId}::uuid,
              ${grant.fileId}::uuid,
              ${grant.recordTypeId}::uuid,
              ${grant.recordId}::uuid,
              ${grant.fieldId}::uuid,
              ${JSON.stringify(grant.actor)}::jsonb,
              ${purpose},
              ${correlationId}::uuid,
              ${grant.expiresAt}::timestamptz
            ) as result
          `,
        ),
      );
      if (result?.outcome !== "recorded") throw new Error("FILE_READ_GRANT_REFUSED");
    },
    claimDownloadGrant: async (oneTimeId): Promise<ClaimedDownloadGrant | null> => {
      const result = singleResult(
        await transaction.query<ResultRow>`
            select vortex_platform.claim_file_download_grant(${oneTimeId}::uuid) as result
          `,
      );
      if (result === null) return null;
      return claimedDownloadGrantSchema.parse(result);
    },
  };
  return Object.freeze(repository);
};
