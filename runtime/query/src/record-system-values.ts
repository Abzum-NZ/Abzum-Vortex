import "server-only";

import { z } from "zod";
import {
  actorIdSchema,
  groupIdSchema,
  organizationAccountIdSchema,
  timestampSchema,
} from "@vortex/contracts";

/**
 * The closed set of Record system values a Query may disclose: created-at and
 * creator (`created_at`, `created_by`), changed-at and changer (`updated_at`,
 * `updated_by`) and the record owner. No other physical system column is a
 * supported Query field, so an unsupported name can never be requested.
 */
export const supportedRecordSystemFieldKeys = [
  "created_at",
  "created_by",
  "updated_at",
  "updated_by",
  "owner",
] as const;
export type SupportedRecordSystemFieldKey = (typeof supportedRecordSystemFieldKeys)[number];
export const supportedRecordSystemFieldKeySchema = z.enum(supportedRecordSystemFieldKeys);

/** The record owner is exactly one account or one group, or absent (`null`). */
export const recordSystemOwnerSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("organization_account"),
        organizationAccountId: organizationAccountIdSchema,
      })
      .strict(),
    z.object({ kind: z.literal("group"), groupId: groupIdSchema }).strict(),
  ])
  .nullable();

/**
 * One row's disclosed system values. Each supported key is optional so a
 * declared subset is accepted, but the object is strict: any other key refuses
 * the page instead of reaching a caller.
 */
export const recordSystemValuesSchema = z
  .object({
    created_at: timestampSchema.optional(),
    created_by: actorIdSchema.optional(),
    updated_at: timestampSchema.optional(),
    updated_by: actorIdSchema.optional(),
    owner: recordSystemOwnerSchema.optional(),
  })
  .strict();
export type RecordSystemValues = z.infer<typeof recordSystemValuesSchema>;
