import "server-only";

import { z } from "zod";
import {
  applicationRootIdSchema,
  builderKeySchema,
  fieldIdSchema,
  jsonValueSchema,
  organizationIdSchema,
  publishedModuleQueryDescriptorV3Schema,
  recordIdSchema,
} from "@vortex/contracts";

/** The exact organisation and installed application a protected query executes within. */
export const protectedQueryScopeSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
  })
  .strict();
export type ProtectedQueryScope = z.infer<typeof protectedQueryScopeSchema>;

export const protectedQueryRequestSchema = z
  .object({
    scope: protectedQueryScopeSchema,
    /** Already resolved via `resolvePublishedModuleQuery` against the installed release. */
    descriptor: publishedModuleQueryDescriptorV3Schema,
    inputValues: z.record(builderKeySchema, jsonValueSchema),
    requestedFieldIds: z.array(fieldIdSchema).min(1).max(200),
    pageSize: z.number().int().min(1).max(200),
    continuationToken: z.string().min(1).max(4_000).optional(),
  })
  .strict();
export type ProtectedQueryRequest = z.infer<typeof protectedQueryRequestSchema>;

export const protectedQueryRowSchema = z
  .object({
    recordId: recordIdSchema,
    values: z.record(fieldIdSchema, jsonValueSchema),
  })
  .strict();
export type ProtectedQueryRow = z.infer<typeof protectedQueryRowSchema>;

export const protectedQueryRefusalReasonCodes = [
  "scope_invalid",
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
    rows: z.array(protectedQueryRowSchema),
    nextContinuationToken: z.string().optional(),
  })
  .strict();
export type ProtectedQueryPage = z.infer<typeof protectedQueryPageSchema>;

export const protectedQueryResultSchema = z.discriminatedUnion("outcome", [
  protectedQueryPageSchema,
  protectedQueryRefusalSchema,
]);
export type ProtectedQueryResult = z.infer<typeof protectedQueryResultSchema>;

/** Every request refusal is this one neutral shape; no reason is more specific than its code. */
export class ProtectedQueryRefusalOutcome extends Error {
  constructor(readonly reasonCode: ProtectedQueryRefusalReasonCode) {
    super(`vortex.query.refused_${reasonCode}`);
    this.name = "ProtectedQueryRefusalOutcome";
  }
}
