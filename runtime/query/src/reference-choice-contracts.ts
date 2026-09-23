import "server-only";

import { z } from "zod";
import {
  fieldIdSchema,
  moduleRootIdSchema,
  organizationAccountIdSchema,
  queryIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
} from "@vortex/contracts";

/**
 * Command to query choices for a record-reference form or action input.
 * Built on #572, returning only records of the allowed types that the current
 * viewer may read, with bounded search and paging.
 */
export const recordReferenceChoiceCommandSchema = z
  .object({
    kind: z.literal("record_reference"),
    /** Allowed record types declared by the reference input. Min 1, max 20. */
    recordTypeIds: z
      .array(recordTypeIdSchema)
      .min(1)
      .max(20)
      .refine(
        (ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length,
        { message: "Each record type is named once" },
      ),
    /** Optional search text to filter choices. Bounded length (max 100). */
    search: z.string().trim().max(100).optional(),
    /** Bounded page size (min 1, max 200, default 50). */
    pageSize: z.number().int().min(1).max(200).default(50),
    /** Opaque continuation token for keyset/offset paging. */
    continuationToken: z.string().min(1).max(65_536).optional(),
    /** Optional module root ID if bound to a published module query. */
    moduleRootId: moduleRootIdSchema.optional(),
    /** Optional query ID if bound to a published module query. */
    queryId: queryIdSchema.optional(),
    /** Optional field ID to use as the choice label. */
    labelFieldId: fieldIdSchema.optional(),
  })
  .strict();
export type RecordReferenceChoiceCommand = z.infer<typeof recordReferenceChoiceCommandSchema>;

/**
 * Command to query choices for an account-reference form or action input.
 * Limited to active accounts in the current organisation; cross-organisation
 * choices are forbidden.
 */
export const organizationAccountReferenceChoiceCommandSchema = z
  .object({
    kind: z.literal("organization_account_reference"),
    /** Optional search text to filter account choices by display name. Bounded length (max 100). */
    search: z.string().trim().max(100).optional(),
    /** Bounded page size (min 1, max 200, default 50). */
    pageSize: z.number().int().min(1).max(200).default(50),
    /** Opaque continuation token for paging. */
    continuationToken: z.string().min(1).max(65_536).optional(),
  })
  .strict();
export type OrganizationAccountReferenceChoiceCommand = z.infer<
  typeof organizationAccountReferenceChoiceCommandSchema
>;

/** Unified reference choice command. */
export const referenceChoiceCommandSchema = z.discriminatedUnion("kind", [
  recordReferenceChoiceCommandSchema,
  organizationAccountReferenceChoiceCommandSchema,
]);
export type ReferenceChoiceCommand = z.infer<typeof referenceChoiceCommandSchema>;

/** One reference choice option for form selection. */
export const referenceChoiceOptionSchema = z
  .object({
    key: z.string().min(1).max(120),
    label: z.string().min(1).max(200),
    recordTypeId: recordTypeIdSchema.optional(),
    recordId: recordIdSchema.optional(),
    organizationAccountId: organizationAccountIdSchema.optional(),
  })
  .strict();
export type ReferenceChoiceOption = z.infer<typeof referenceChoiceOptionSchema>;

export const referenceChoiceRefusalReasonCodes = [
  "request_invalid",
  "scope_unauthorized",
  "record_type_unsupported",
  "cross_organization_forbidden",
  "query_unavailable",
  "cursor_invalid",
  "cursor_stale",
] as const;
export type ReferenceChoiceRefusalReasonCode = (typeof referenceChoiceRefusalReasonCodes)[number];

export const referenceChoiceRefusalSchema = z
  .object({
    outcome: z.literal("refused"),
    reasonCode: z.enum(referenceChoiceRefusalReasonCodes),
  })
  .strict();
export type ReferenceChoiceRefusal = z.infer<typeof referenceChoiceRefusalSchema>;

export const referenceChoicePageSchema = z
  .object({
    outcome: z.literal("completed"),
    kind: z.enum(["record_reference", "organization_account_reference"]),
    choices: z.array(referenceChoiceOptionSchema).max(200),
    nextContinuationToken: z.string().optional(),
  })
  .strict();
export type ReferenceChoicePage = z.infer<typeof referenceChoicePageSchema>;

export const referenceChoiceResultSchema = z.discriminatedUnion("outcome", [
  referenceChoicePageSchema,
  referenceChoiceRefusalSchema,
]);
export type ReferenceChoiceResult = z.infer<typeof referenceChoiceResultSchema>;
