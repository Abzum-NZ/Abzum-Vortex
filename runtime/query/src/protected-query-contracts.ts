import "server-only";

import { z } from "zod";
import {
  builderKeySchema,
  fieldIdSchema,
  jsonValueSchema,
  moduleRootIdSchema,
  queryIdSchema,
  recordIdSchema,
  stableDefinitionReleaseVersionSchema,
} from "@vortex/contracts";
import {
  recordSystemValuesSchema,
  supportedRecordSystemFieldKeySchema,
  type RecordSystemValues,
} from "./record-system-values";

/**
 * One protected Query request. It names only the published Module query and the
 * caller's typed values: the organisation, Application and actor come from the
 * verified request, and the query declaration from the exact installed release.
 */
export const protectedQueryCommandSchema = z
  .object({
    moduleRootId: moduleRootIdSchema,
    queryId: queryIdSchema,
    inputValues: z.record(builderKeySchema, jsonValueSchema),
    requestedFieldIds: z
      .array(fieldIdSchema)
      .min(1)
      .max(200)
      .refine(
        (fieldIds) => new Set(fieldIds.map((fieldId) => fieldId.toLowerCase())).size === fieldIds.length,
        { message: "Each requested field is named once" },
      ),
    /**
     * The supported Record system metadata fields this request declares. Only
     * these values may appear in a row's `systemValues`; an unsupported or
     * repeated key refuses the whole request, and an undeclared value can never
     * be mapped or inferred.
     */
    requestedSystemFieldKeys: z
      .array(supportedRecordSystemFieldKeySchema)
      .max(5)
      .refine((keys) => new Set(keys).size === keys.length, {
        message: "Each system field is declared once",
      })
      .default([]),
    pageSize: z.number().int().min(1).max(200),
    continuationToken: z.string().min(1).max(65_536).optional(),
  })
  .strict();
export type ProtectedQueryCommand = z.infer<typeof protectedQueryCommandSchema>;

export const protectedQueryRowSchema = z
  .object({
    recordId: recordIdSchema,
    /** Readable requested fields only; a withheld field is absent rather than blank. */
    values: z.record(fieldIdSchema, jsonValueSchema),
    /**
     * The declared supported system metadata values for this row, or absent when
     * the request declares none. Undeclared values never appear.
     */
    systemValues: recordSystemValuesSchema.optional(),
  })
  .strict();
export type ProtectedQueryRow = z.infer<typeof protectedQueryRowSchema>;
export type { RecordSystemValues };

export const protectedQueryRefusalReasonCodes = [
  "request_invalid",
  "query_unavailable",
  "descriptor_invalid",
  "input_invalid",
  "field_unbounded",
  "filter_invalid",
  "sort_invalid",
  "relationship_invalid",
  "page_size_invalid",
  "cursor_invalid",
  "cursor_stale",
  "freshness_pending",
] as const;
export type ProtectedQueryRefusalReasonCode = (typeof protectedQueryRefusalReasonCodes)[number];

/** Every refusal is this one neutral shape; it is decided before any row is exposed. */
export const protectedQueryRefusalSchema = z
  .object({
    outcome: z.literal("refused"),
    reasonCode: z.enum(protectedQueryRefusalReasonCodes),
  })
  .strict();
export type ProtectedQueryRefusal = z.infer<typeof protectedQueryRefusalSchema>;

export const protectedQueryPageSchema = z
  .object({
    outcome: z.literal("completed"),
    moduleRootId: moduleRootIdSchema,
    moduleReleaseVersion: stableDefinitionReleaseVersionSchema,
    queryId: queryIdSchema,
    rows: z.array(protectedQueryRowSchema).max(200),
    /** Opaque; present only when a later page may hold further permitted rows. */
    nextContinuationToken: z.string().optional(),
  })
  .strict();
export type ProtectedQueryPage = z.infer<typeof protectedQueryPageSchema>;

export const protectedQueryResultSchema = z.discriminatedUnion("outcome", [
  protectedQueryPageSchema,
  protectedQueryRefusalSchema,
]);
export type ProtectedQueryResult = z.infer<typeof protectedQueryResultSchema>;
