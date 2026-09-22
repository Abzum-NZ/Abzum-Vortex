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
  })
  .strict();
export type ProtectedQueryRow = z.infer<typeof protectedQueryRowSchema>;

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
