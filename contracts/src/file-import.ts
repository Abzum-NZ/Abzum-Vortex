import { z } from "zod";
import { correlationIdSchema } from "./common";
import {
  applicationRootIdSchema,
  fieldIdSchema,
  fileIdSchema,
  fingerprintSchema,
  identityIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  timestampSchema,
} from "./identifiers";

export const STRUCTURED_RECORD_IMPORT_FORMAT = "vortex.record-import/1" as const;
export const STRUCTURED_RECORD_IMPORT_MAXIMUM_SOURCE_BYTES = 5 * 1024 * 1024;
export const STRUCTURED_RECORD_IMPORT_MAXIMUM_COLUMNS = 500;
export const STRUCTURED_RECORD_IMPORT_MAXIMUM_ROWS = 500;
export const STRUCTURED_RECORD_IMPORT_MAXIMUM_CELL_SOURCE_BYTES = 64 * 1024;
export const STRUCTURED_RECORD_IMPORT_MAXIMUM_NESTING_DEPTH = 16;
export const STRUCTURED_RECORD_IMPORT_MAXIMUM_JSON_ENTRIES = 100_000;

export const structuredRecordImportFormatSchema = z.literal(STRUCTURED_RECORD_IMPORT_FORMAT);

const atMost256CodePoints = (value: string): boolean => {
  const characters = value[Symbol.iterator]();
  for (let count = 0; count < 257; count += 1) {
    if (characters.next().done) return true;
  }
  return false;
};

export const structuredRecordImportColumnSchema = z
  .object({
    columnId: z.string().min(1).max(256),
    label: z.string().refine(atMost256CodePoints).optional(),
  })
  .strict();

export const structuredRecordImportColumnsSchema = z
  .array(structuredRecordImportColumnSchema)
  .max(STRUCTURED_RECORD_IMPORT_MAXIMUM_COLUMNS)
  .superRefine((columns, context) => {
    const seen = new Set<string>();
    columns.forEach((column, index) => {
      if (seen.has(column.columnId)) {
        context.addIssue({
          code: "custom",
          path: [index, "columnId"],
          message: "Column identifiers are unique within one source document",
        });
      }
      seen.add(column.columnId);
    });
  });

const safeDecodedCellsSchema = z.custom<Readonly<Record<string, unknown>>>((value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length > STRUCTURED_RECORD_IMPORT_MAXIMUM_COLUMNS) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return keys.every((key) => {
      if (typeof key !== "string" || key.length > 256 || key.length === 0) return false;
      const descriptor = descriptors[key];
      return descriptor !== undefined && descriptor.enumerable === true && "value" in descriptor;
    });
  } catch {
    return false;
  }
});

export const decodedRecordImportRowSchema = z
  .object({
    rowNumber: z.number().int().safe().min(1).max(STRUCTURED_RECORD_IMPORT_MAXIMUM_ROWS),
    cells: safeDecodedCellsSchema,
  })
  .strict();

export const recordImportSourceDescriptorSchema = z
  .object({
    format: structuredRecordImportFormatSchema,
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    fileId: fileIdSchema,
    checksum: fingerprintSchema,
    sizeBytes: z.number().int().safe().min(0).max(STRUCTURED_RECORD_IMPORT_MAXIMUM_SOURCE_BYTES),
    ownerRecordTypeId: recordTypeIdSchema,
    ownerRecordId: recordIdSchema,
    ownerFieldId: fieldIdSchema,
    viewerIdentityId: identityIdSchema,
    viewerOrganizationAccountId: organizationAccountIdSchema,
    correlationId: correlationIdSchema,
    issuedAt: timestampSchema,
    validUntil: timestampSchema,
  })
  .strict();

export const recordImportSourceRefusalReasonSchema = z.enum([
  "malformed_request",
  "file_not_found",
  "source_too_large",
  "source_changed",
  "source_expired",
  "storage_unavailable",
  "unsupported_format",
  "invalid_encoding",
  "invalid_json",
  "duplicate_member",
  "invalid_number",
  "invalid_document",
  "too_many_columns",
  "too_many_rows",
  "row_width_mismatch",
  "cell_too_large",
  "resource_limit",
]);

const recordImportSourceResultUnionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("available"),
      source: recordImportSourceDescriptorSchema,
      columns: structuredRecordImportColumnsSchema,
      rows: z.array(decodedRecordImportRowSchema).max(STRUCTURED_RECORD_IMPORT_MAXIMUM_ROWS),
    })
    .strict(),
  z
    .object({
      kind: z.literal("refused"),
      reason: recordImportSourceRefusalReasonSchema,
      rowNumber: z
        .number()
        .int()
        .safe()
        .min(1)
        .max(STRUCTURED_RECORD_IMPORT_MAXIMUM_ROWS)
        .optional(),
      columnNumber: z
        .number()
        .int()
        .safe()
        .min(1)
        .max(STRUCTURED_RECORD_IMPORT_MAXIMUM_COLUMNS)
        .optional(),
    })
    .strict(),
]);

export const recordImportSourceResultSchema = recordImportSourceResultUnionSchema.superRefine(
  (result, context) => {
    if (result.kind !== "available") return;
    const expectedIds = result.columns.map((column) => column.columnId);
    result.rows.forEach((row, index) => {
      if (row.rowNumber !== index + 1) {
        context.addIssue({
          code: "custom",
          path: ["rows", index, "rowNumber"],
          message: "Decoded row numbers follow their one-based source order",
        });
      }
      const actualIds = Reflect.ownKeys(row.cells);
      if (
        actualIds.length !== expectedIds.length ||
        expectedIds.some((columnId) => !Object.prototype.hasOwnProperty.call(row.cells, columnId))
      ) {
        context.addIssue({
          code: "custom",
          path: ["rows", index, "cells"],
          message: "Decoded cells contain exactly the source column identifiers",
        });
      }
    });
  },
);

export type StructuredRecordImportFormat = z.infer<typeof structuredRecordImportFormatSchema>;
export type StructuredRecordImportColumn = Readonly<
  z.infer<typeof structuredRecordImportColumnSchema>
>;
export type DecodedRecordImportRow = Readonly<z.infer<typeof decodedRecordImportRowSchema>>;
export type RecordImportSourceDescriptor = Readonly<
  z.infer<typeof recordImportSourceDescriptorSchema>
>;
export type RecordImportSourceRefusalReason = z.infer<typeof recordImportSourceRefusalReasonSchema>;
export type RecordImportSourceResult =
  | Readonly<{
      kind: "available";
      source: RecordImportSourceDescriptor;
      columns: readonly StructuredRecordImportColumn[];
      rows: readonly DecodedRecordImportRow[];
    }>
  | Readonly<{
      kind: "refused";
      reason: RecordImportSourceRefusalReason;
      rowNumber?: number;
      columnNumber?: number;
    }>;
