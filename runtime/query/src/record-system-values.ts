import "server-only";

import { z } from "zod";
import {
  actorIdSchema,
  groupIdSchema,
  jsonValueSchema,
  organizationAccountIdSchema,
  timestampSchema,
  type JsonValue,
} from "@vortex/contracts";

/**
 * The closed set of Record system metadata values a Query may disclose.
 *
 * These are the fixed creation/change audit values of the [record storage
 * contract]: created-at and creator (`created_at`, `created_by`), changed-at and
 * changer (`updated_at`, `updated_by`) and the record owner. No other physical
 * system column is a supported Query field, so an unsupported name can never be
 * requested, mapped or inferred.
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

/** The record owner is exactly one account or group owner, or absent (none/inherited). */
export const recordSystemOwnerSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("organization_account"),
        organizationAccountId: organizationAccountIdSchema,
      })
      .strict(),
    z.object({ kind: z.literal("group"), groupId: groupIdSchema }).strict(),
  ]);
export type RecordSystemOwner = z.infer<typeof recordSystemOwnerSchema>;

/**
 * The current Record metadata a Query may map from. It carries only the
 * supported system values; a supplier that adds an undeclared system value is
 * refused rather than silently reduced, so nothing outside the allowed set can
 * reach a caller.
 */
export const recordSystemMetadataSchema = z
  .object({
    created_at: timestampSchema,
    created_by: actorIdSchema,
    updated_at: timestampSchema,
    updated_by: actorIdSchema,
    owner: recordSystemOwnerSchema.nullable(),
  })
  .strict();
export type RecordSystemMetadata = z.infer<typeof recordSystemMetadataSchema>;

/**
 * One row's disclosed system values. Each supported key is optional so a
 * declared subset is accepted, but the object is strict: an unsupported or
 * undeclared system key refuses the whole row projection rather than appearing
 * in a result.
 */
export const recordSystemValuesSchema = z
  .object({
    created_at: jsonValueSchema.optional(),
    created_by: jsonValueSchema.optional(),
    updated_at: jsonValueSchema.optional(),
    updated_by: jsonValueSchema.optional(),
    owner: jsonValueSchema.optional(),
  })
  .strict();
export type RecordSystemValues = z.infer<typeof recordSystemValuesSchema>;

const uniqueSupportedKeys = (keys: readonly string[]): boolean =>
  new Set(keys).size === keys.length;

/** A caller declares each supported system field at most once. */
export const declaredRecordSystemFieldKeysSchema = z
  .array(supportedRecordSystemFieldKeySchema)
  .max(supportedRecordSystemFieldKeys.length)
  .refine(uniqueSupportedKeys, { message: "Each system field is declared once" });

const jsonSafeOwner = (owner: RecordSystemOwner | null): JsonValue =>
  owner === null ? null : (owner as unknown as JsonValue);

/**
 * Projects one row's current Record metadata to only the declared supported
 * system fields. An undeclared supported value is dropped and an unsupported or
 * malformed metadata value refuses the whole projection, so undeclared system
 * values can never appear in a result.
 */
export const projectDeclaredRecordSystemValues = (
  metadataCandidate: unknown,
  declaredFieldKeys: readonly unknown[],
): RecordSystemValues | undefined => {
  const declared = declaredRecordSystemFieldKeysSchema.safeParse(declaredFieldKeys);
  const metadata = recordSystemMetadataSchema.safeParse(metadataCandidate);
  if (!declared.success || !metadata.success) return undefined;

  const values: Record<string, JsonValue> = {};
  for (const key of declared.data) {
    switch (key) {
      case "created_at":
        values[key] = metadata.data.created_at;
        break;
      case "created_by":
        values[key] = metadata.data.created_by;
        break;
      case "updated_at":
        values[key] = metadata.data.updated_at;
        break;
      case "updated_by":
        values[key] = metadata.data.updated_by;
        break;
      case "owner":
        values[key] = jsonSafeOwner(metadata.data.owner);
        break;
    }
  }
  return values as RecordSystemValues;
};

/**
 * True only when the metadata carries exactly the supported system values and
 * no undeclared physical system column.
 */
export const recordSystemMetadataIsSupported = (metadataCandidate: unknown): boolean =>
  recordSystemMetadataSchema.safeParse(metadataCandidate).success;
