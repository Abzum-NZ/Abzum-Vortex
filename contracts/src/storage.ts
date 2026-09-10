import { z } from "zod";
import {
  applicationRootIdSchema,
  fieldIdSchema,
  fingerprintSchema,
  moduleRootIdSchema,
  organizationIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  storageContractIdSchema,
} from "./identifiers";

export const recordStorageSchemaTokenSchema = z.literal("record_data");

export const recordStorageTableTokenSchema = z
  .string()
  .length(35)
  .regex(/^rt_[a-f0-9]{32}$/, "Record table tokens retain the complete storage identity");

export const recordStorageColumnTokenSchema = z
  .string()
  .length(34)
  .regex(/^f_[a-f0-9]{32}$/, "Record field tokens retain the complete field identity");

export const physicalStorageTokenSchema = z.union([
  recordStorageTableTokenSchema,
  recordStorageColumnTokenSchema,
]);

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
    physicalSchemaToken: recordStorageSchemaTokenSchema,
    physicalTableToken: recordStorageTableTokenSchema,
    moduleRootId: moduleRootIdSchema,
    recordTypeId: recordTypeIdSchema,
    storageScope: z.enum(["organization_shared", "application_contained"]),
    compatibleRevisions: compatibleRevisionRangeSchema,
    state: z.enum(["planned", "active", "retired"]),
    generatorContractVersion: z.literal("1.0.0"),
    contentFingerprint: fingerprintSchema,
  })
  .strict();

export const fieldStorageMappingSchema = z
  .object({
    storageContractId: storageContractIdSchema,
    fieldId: fieldIdSchema,
    physicalColumnToken: recordStorageColumnTokenSchema,
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
    introducedByModuleRootId: moduleRootIdSchema,
    introducedAtReleaseRevision: revisionSchema,
    retiredByModuleRootId: moduleRootIdSchema.optional(),
    retiredAtReleaseRevision: revisionSchema.optional(),
    state: z.enum(["planned", "active", "retired"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.retiredByModuleRootId === undefined) !==
      (value.retiredAtReleaseRevision === undefined)
    )
      context.addIssue({
        code: "custom",
        path: ["retiredAtReleaseRevision"],
        message: "Field retirement requires one exact owning module release",
      });
    if (value.state === "retired" && value.retiredAtReleaseRevision === undefined)
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "A retired field mapping requires retirement provenance",
      });
    if (value.state !== "retired" && value.retiredAtReleaseRevision !== undefined)
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "Only a retired field mapping carries retirement provenance",
      });
  });

const javascriptSafeRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);

export const moduleInstallationStorageCommandSchema = z
  .object({
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: javascriptSafeRevisionSchema,
    moduleRootId: moduleRootIdSchema,
    moduleReleaseRevision: javascriptSafeRevisionSchema,
    expectedBindingRevision: javascriptSafeRevisionSchema.nullable(),
  })
  .strict();

const canonicalStorageContractIdsSchema = z
  .array(storageContractIdSchema)
  .min(1)
  .max(500)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length)
      context.addIssue({ code: "custom", message: "Storage contract identities must be unique" });
    if (values.some((value, index) => index > 0 && values[index - 1]! >= value))
      context.addIssue({
        code: "custom",
        message: "Storage contract identities must use canonical order",
      });
  });

export const moduleInstallationStorageResultSchema = z
  .object({
    state: z.literal("provisioned"),
    changed: z.boolean(),
    bindingRevision: javascriptSafeRevisionSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: javascriptSafeRevisionSchema,
    moduleRootId: moduleRootIdSchema,
    moduleReleaseRevision: javascriptSafeRevisionSchema,
    contentFingerprint: fingerprintSchema,
    resolutionFingerprint: fingerprintSchema,
    generatorContractVersion: z.literal("1.0.0"),
    storageContractIds: canonicalStorageContractIdsSchema,
  })
  .strict();

/** Exact persisted Module binding evidence; never caller-authored readiness. */
export const moduleInstallationBindingEvidenceSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    moduleRootId: moduleRootIdSchema,
    bindingRevision: javascriptSafeRevisionSchema,
    applicationReleaseRevision: javascriptSafeRevisionSchema,
    moduleReleaseRevision: javascriptSafeRevisionSchema,
    state: z.enum(["provisioned", "active", "detached"]),
  })
  .strict();

/** The complete active binding set selected from trusted human application context. */
export const activeApplicationInstallationEvidenceSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: javascriptSafeRevisionSchema,
    moduleBindings: z.array(moduleInstallationBindingEvidenceSchema).min(1).max(10_000),
  })
  .strict()
  .superRefine((value, context) => {
    const moduleRootIds = value.moduleBindings.map((binding) => binding.moduleRootId);
    if (new Set(moduleRootIds).size !== moduleRootIds.length)
      context.addIssue({
        code: "custom",
        path: ["moduleBindings"],
        message: "An active installation has one binding per Module root",
      });
    for (const [index, binding] of value.moduleBindings.entries())
      if (
        binding.state !== "active" ||
        binding.organizationId !== value.organizationId ||
        binding.applicationRootId !== value.applicationRootId ||
        binding.applicationReleaseRevision !== value.applicationReleaseRevision
      )
        context.addIssue({
          code: "custom",
          path: ["moduleBindings", index],
          message: "Active Module binding evidence must match its Application installation",
        });
  });

export const moduleInstallationStorageErrorCodeSchema = z.enum([
  "INVALID_MODULE_INSTALLATION_STORAGE_COMMAND",
  "MODULE_INSTALLATION_AUTHORITY_REFUSED",
  "MODULE_INSTALLATION_RELEASE_UNAVAILABLE",
  "MODULE_INSTALLATION_RELEASE_MISMATCH",
  "MODULE_INSTALLATION_BINDING_CONFLICT",
  "RECORD_STORAGE_INCOMPATIBLE",
  "RECORD_STORAGE_PROVISIONING_FAILED",
]);

export const activeApplicationInstallationErrorCodeSchema = z.enum([
  "ACTIVE_APPLICATION_CONTEXT_REFUSED",
  "ACTIVE_APPLICATION_INSTALLATION_UNAVAILABLE",
  "ACTIVE_APPLICATION_INSTALLATION_INCOMPLETE",
  "ACTIVE_APPLICATION_INSTALLATION_READ_FAILED",
]);

export const recordStorageReleaseProvisionSchema = z
  .object({
    moduleRootId: moduleRootIdSchema,
    releaseRevision: javascriptSafeRevisionSchema,
    contentFingerprint: fingerprintSchema,
    resolutionFingerprint: fingerprintSchema,
    generatorContractVersion: z.literal("1.0.0"),
    storageContractIds: canonicalStorageContractIdsSchema,
  })
  .strict();

export type StorageCatalogEntry = z.infer<typeof storageCatalogEntrySchema>;
export type FieldStorageMapping = z.infer<typeof fieldStorageMappingSchema>;
export type CompatibleRevisionRange = z.infer<typeof compatibleRevisionRangeSchema>;
export type ModuleInstallationStorageCommand = z.infer<
  typeof moduleInstallationStorageCommandSchema
>;
export type ModuleInstallationStorageResult = z.infer<typeof moduleInstallationStorageResultSchema>;
export type ModuleInstallationBindingEvidence = z.infer<
  typeof moduleInstallationBindingEvidenceSchema
>;
export type ActiveApplicationInstallationEvidence = z.infer<
  typeof activeApplicationInstallationEvidenceSchema
>;
export type ModuleInstallationStorageErrorCode = z.infer<
  typeof moduleInstallationStorageErrorCodeSchema
>;
export type ActiveApplicationInstallationErrorCode = z.infer<
  typeof activeApplicationInstallationErrorCodeSchema
>;
export type RecordStorageReleaseProvision = z.infer<typeof recordStorageReleaseProvisionSchema>;
