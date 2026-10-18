import "server-only";
import { z } from "zod";
import {
  fileRecordSchema,
  verifiedFileActorSchema,
  uploadGrantSchema,
  correlationIdSchema,
  platformIdSchema,
  fileIdSchema,
  timestampSchema,
  fileUploadRenewalRefusalReasonSchema,
  fileUploadCompletionRefusalReasonSchema,
} from "../schema";
import type { RequestDatabaseTransaction } from "../db/index";
import type { FileUploadRepository } from "./upload";

const pendingSchema = z
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
const reservationSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("reserved"), fileRecord: fileRecordSchema }).strict(),
  z
    .object({
      outcome: z.literal("refused"),
      reason: z.enum(["field_capacity_exceeded", "replacement_file_not_found"]),
    })
    .strict(),
]);
const renewalSchema = z.discriminatedUnion("outcome", [
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
const completionSchema = z.discriminatedUnion("outcome", [
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

/** Durable upload state belongs to the protected request transaction. */
export const createSqlFileUploadRepository = (
  transaction: RequestDatabaseTransaction,
): FileUploadRepository => {
  const call = async (operation: string, input: unknown): Promise<unknown> => {
    const rows = await transaction.query<{
      result: unknown;
    }>`select vortex_platform.file_upload_operation(${operation}::text,${JSON.stringify(input)}::text::jsonb) as result`;
    if (rows.length !== 1 || rows[0] === undefined) throw new Error("FILE_UPLOAD_RESULT_INVALID");
    return rows[0].result;
  };
  return {
    reservePendingUpload: async (input) => reservationSchema.parse(await call("reserve", input)),
    readPendingUpload: async (fileId) =>
      pendingSchema.nullable().parse(await call("read", { fileId })),
    renewUploadGrant: async (input) => renewalSchema.parse(await call("renew", input)),
    claimUploadGrant: async (oneTimeId) =>
      z
        .object({
          grant: uploadGrantSchema,
          fileRecord: fileRecordSchema,
          correlationId: correlationIdSchema,
        })
        .strict()
        .nullable()
        .parse(await call("claim", { oneTimeId })),
    recordUploadOutcome: async (input) => completionSchema.parse(await call("complete", input)),
  };
};
