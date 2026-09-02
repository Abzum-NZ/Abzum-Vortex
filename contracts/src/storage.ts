import { z } from "zod";
import {
  fieldIdSchema,
  fingerprintSchema,
  migrationIdSchema,
  moduleRootIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  storageContractIdSchema,
} from "./identifiers";

export const physicalStorageTokenSchema = z
  .string()
  .min(5)
  .max(63)
  .regex(/^vtx_[a-z0-9_]+$/, "Physical tokens are opaque PostgreSQL-safe values");

export const compatibleRevisionRangeSchema = z
  .object({ firstRevision: revisionSchema, lastRevision: revisionSchema.optional() })
  .strict()
  .refine(
    (range) => range.lastRevision === undefined || range.lastRevision >= range.firstRevision,
    {
      message: "The last compatible revision cannot precede the first",
    },
  );

export const storageCatalogEntrySchema = z
  .object({
    storageContractId: storageContractIdSchema,
    owningService: z.literal("record"),
    physicalSchemaToken: physicalStorageTokenSchema,
    physicalTableToken: physicalStorageTokenSchema,
    moduleRootId: moduleRootIdSchema,
    recordTypeId: recordTypeIdSchema,
    compatibleRevisions: compatibleRevisionRangeSchema,
    state: z.enum(["planned", "active", "retired"]),
    creationMigrationId: migrationIdSchema,
    contentFingerprint: fingerprintSchema,
  })
  .strict();

export const fieldStorageMappingSchema = z
  .object({
    storageContractId: storageContractIdSchema,
    fieldId: fieldIdSchema,
    physicalColumnToken: physicalStorageTokenSchema,
    databaseValueType: z.enum([
      "boolean",
      "date",
      "decimal",
      "integer",
      "json",
      "text",
      "timestamp_with_time_zone",
      "uuid",
    ]),
    introductionMigrationId: migrationIdSchema,
    retirementMigrationId: migrationIdSchema.optional(),
    state: z.enum(["planned", "active", "retired"]),
  })
  .strict();

export type StorageCatalogEntry = z.infer<typeof storageCatalogEntrySchema>;
export type FieldStorageMapping = z.infer<typeof fieldStorageMappingSchema>;
