import { z } from "zod";
import { correlationIdSchema } from "./common";
import {
  actorIdSchema,
  applicationRootIdSchema,
  fingerprintSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  organizationIdSchema,
  permissionIdSchema,
  platformIdSchema,
  revisionSchema,
  semanticVersionSchema,
} from "./identifiers";
import { permissionDeclarationSchema } from "./permissions";
import { stableDefinitionReleaseVersionSchema } from "./version-impact";

const javascriptSafeRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);

const permissionRegistryDefinitionReleaseCommon = {
  definitionKey: namespacedKeySchema,
  releaseRevision: javascriptSafeRevisionSchema,
  releaseVersion: stableDefinitionReleaseVersionSchema,
  validationContractVersion: semanticVersionSchema,
  contentFingerprint: fingerprintSchema,
  resolutionFingerprint: fingerprintSchema,
};

export const permissionRegistryDefinitionReleaseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("application"),
      rootId: applicationRootIdSchema,
      ...permissionRegistryDefinitionReleaseCommon,
    })
    .strict(),
  z
    .object({
      kind: z.literal("module"),
      rootId: moduleRootIdSchema,
      ...permissionRegistryDefinitionReleaseCommon,
    })
    .strict(),
]);

export const permissionRegistryPlatformReleaseSchema = z
  .object({
    kind: z.literal("platform_catalogue"),
    ownerId: platformIdSchema,
    catalogueVersion: semanticVersionSchema,
    catalogueFingerprint: fingerprintSchema,
  })
  .strict();

export const permissionRegistryEntryCandidateSchema = z
  .object({
    applicationRootId: applicationRootIdSchema,
    ownerKind: z.enum(["application", "module"]),
    ownerId: platformIdSchema,
    permission: permissionDeclarationSchema,
    sourceRelease: permissionRegistryDefinitionReleaseSchema,
    meaningFingerprint: fingerprintSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.sourceRelease.kind !== value.ownerKind ||
      String(value.sourceRelease.rootId) !== String(value.ownerId)
    )
      context.addIssue({
        code: "custom",
        path: ["sourceRelease"],
        message: "Permission ownership must match its exact source release",
      });
    if (
      value.ownerKind === "application" &&
      String(value.ownerId) !== String(value.applicationRootId)
    )
      context.addIssue({
        code: "custom",
        path: ["applicationRootId"],
        message: "An application permission must retain its owning application context",
      });
  });

export const preparedApplicationPermissionRegistrationSchema = z
  .object({
    contractVersion: z.literal("1.0.0"),
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationRelease: permissionRegistryDefinitionReleaseSchema.and(
      z.object({ kind: z.literal("application") }),
    ),
    applicationCatalogueFingerprint: fingerprintSchema,
    applicationPermissionIds: z.array(permissionIdSchema),
    entries: z.array(permissionRegistryEntryCandidateSchema),
    candidateFingerprint: fingerprintSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.applicationRelease.rootId !== value.applicationRootId ||
      value.entries.some((entry) => entry.applicationRootId !== value.applicationRootId)
    )
      context.addIssue({
        code: "custom",
        path: ["applicationRootId"],
        message: "Registration evidence must retain one exact application context",
      });

    const identities = value.entries.map(
      (entry) => `${entry.ownerKind}:${entry.ownerId}:${entry.permission.permissionId}`,
    );
    const keys = value.entries.map(
      (entry) => `${entry.ownerKind}:${entry.ownerId}:${entry.permission.key}`,
    );
    if (new Set(identities).size !== identities.length)
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "Permission identities must be unique within an owner",
      });
    if (new Set(keys).size !== keys.length)
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "Permission keys must be unique within an owner",
      });
    if (new Set(value.applicationPermissionIds).size !== value.applicationPermissionIds.length)
      context.addIssue({
        code: "custom",
        path: ["applicationPermissionIds"],
        message: "Application permission snapshot identities must be unique",
      });
  });

export const permissionRegistryMutationCommandSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("register"),
      candidate: preparedApplicationPermissionRegistrationSchema,
      changedBy: actorIdSchema,
      correlationId: correlationIdSchema,
    })
    .strict(),
  ...(["update", "reactivate"] as const).map((operation) =>
    z
      .object({
        operation: z.literal(operation),
        expectedRevision: javascriptSafeRevisionSchema,
        candidate: preparedApplicationPermissionRegistrationSchema,
        changedBy: actorIdSchema,
        correlationId: correlationIdSchema,
      })
      .strict(),
  ),
  z
    .object({
      operation: z.literal("withdraw"),
      organizationId: organizationIdSchema,
      applicationRootId: applicationRootIdSchema,
      expectedRevision: javascriptSafeRevisionSchema,
      changedBy: actorIdSchema,
      correlationId: correlationIdSchema,
    })
    .strict(),
]);

export const permissionRegistryMutationResultSchema = z
  .object({
    operation: z.enum(["register", "update", "reactivate", "withdraw"]),
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    registrationState: z.enum(["active", "withdrawn"]),
    registrationRevision: javascriptSafeRevisionSchema,
    accessVersion: javascriptSafeRevisionSchema,
    correlationId: correlationIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.operation === "withdraw") !== (value.registrationState === "withdrawn"))
      context.addIssue({
        code: "custom",
        path: ["registrationState"],
        message: "Only withdrawal produces a withdrawn registration",
      });
  });

export const permissionCatalogueLookupCommandSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema.optional(),
    ownerKind: z.enum(["platform", "application", "module"]),
    ownerId: platformIdSchema,
    permissionId: permissionIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.ownerKind === "platform") !== (value.applicationRootId === undefined))
      context.addIssue({
        code: "custom",
        path: ["applicationRootId"],
        message: "Only application and module permissions carry application context",
      });
    if (
      value.ownerKind === "application" &&
      String(value.ownerId) !== String(value.applicationRootId)
    )
      context.addIssue({
        code: "custom",
        path: ["ownerId"],
        message: "An application permission must match its application context",
      });
  });

export const permissionCatalogueEntrySchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema.optional(),
    registrationRevision: javascriptSafeRevisionSchema,
    ownerKind: z.enum(["platform", "application", "module"]),
    ownerId: platformIdSchema,
    permission: permissionDeclarationSchema,
    sourceRelease: z.union([
      permissionRegistryDefinitionReleaseSchema,
      permissionRegistryPlatformReleaseSchema,
    ]),
    meaningFingerprint: fingerprintSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ownerKind === "platform") {
      if (
        value.applicationRootId !== undefined ||
        value.sourceRelease.kind !== "platform_catalogue" ||
        String(value.sourceRelease.ownerId) !== String(value.ownerId)
      )
        context.addIssue({
          code: "custom",
          path: ["sourceRelease"],
          message: "A platform permission requires exact platform catalogue evidence",
        });
      return;
    }
    if (
      value.applicationRootId === undefined ||
      value.sourceRelease.kind !== value.ownerKind ||
      String(value.sourceRelease.rootId) !== String(value.ownerId) ||
      (value.ownerKind === "application" &&
        String(value.ownerId) !== String(value.applicationRootId))
    )
      context.addIssue({
        code: "custom",
        path: ["sourceRelease"],
        message: "A definition permission requires exact owner and application-context evidence",
      });
  });

export const permissionCatalogueLookupResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("available"), entry: permissionCatalogueEntrySchema }).strict(),
  z.object({ outcome: z.literal("unavailable") }).strict(),
]);

/** Active exact release reference plus application-only wildcard input; templates stay in Definition. */
export const applicationPermissionCatalogueSnapshotSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    registrationRevision: javascriptSafeRevisionSchema,
    applicationRelease: permissionRegistryDefinitionReleaseSchema.and(
      z.object({ kind: z.literal("application") }),
    ),
    catalogueFingerprint: fingerprintSchema,
    permissionIds: z.array(permissionIdSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.applicationRelease.rootId !== value.applicationRootId)
      context.addIssue({
        code: "custom",
        path: ["applicationRelease"],
        message: "Snapshot release must match its application context",
      });
    if (new Set(value.permissionIds).size !== value.permissionIds.length)
      context.addIssue({
        code: "custom",
        path: ["permissionIds"],
        message: "Snapshot permission identities must be unique",
      });
  });

export const platformPermissionCatalogueSchema = z
  .object({
    catalogueVersion: semanticVersionSchema,
    ownerKind: z.literal("platform"),
    ownerId: platformIdSchema,
    catalogueFingerprint: fingerprintSchema,
    permissions: z.array(permissionDeclarationSchema).min(1),
  })
  .strict();

export const initializePlatformPermissionCatalogueCommandSchema = z
  .object({
    organizationId: organizationIdSchema,
    changedBy: actorIdSchema,
    correlationId: correlationIdSchema,
  })
  .strict();

export const initializePlatformPermissionCatalogueResultSchema = z
  .object({
    organizationId: organizationIdSchema,
    registrationRevision: javascriptSafeRevisionSchema,
    accessVersion: javascriptSafeRevisionSchema,
  })
  .strict();

export const revisePlatformPermissionCatalogueMetadataCommandSchema = z
  .object({
    organizationId: organizationIdSchema,
    expectedRegistrationRevision: z.literal(1),
    sourceCatalogueVersion: z.literal("1.0.0"),
    targetCatalogueVersion: z.literal("1.0.1"),
    changedBy: actorIdSchema,
    correlationId: correlationIdSchema,
  })
  .strict();

export const revisePlatformPermissionCatalogueMetadataResultSchema = z
  .object({
    organizationId: organizationIdSchema,
    sourceCatalogueVersion: z.literal("1.0.0"),
    targetCatalogueVersion: z.literal("1.0.1"),
    registrationRevision: z.literal(2),
    accessVersion: javascriptSafeRevisionSchema,
  })
  .strict();

export const applicationPermissionCatalogueSnapshotCommandSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
  })
  .strict();

export type PermissionRegistryDefinitionRelease = z.infer<
  typeof permissionRegistryDefinitionReleaseSchema
>;
export type PermissionRegistryPlatformRelease = z.infer<
  typeof permissionRegistryPlatformReleaseSchema
>;
export type PermissionRegistryEntryCandidate = z.infer<
  typeof permissionRegistryEntryCandidateSchema
>;
export type PreparedApplicationPermissionRegistration = z.infer<
  typeof preparedApplicationPermissionRegistrationSchema
>;
export type PermissionRegistryMutationCommand = z.infer<
  typeof permissionRegistryMutationCommandSchema
>;
export type PermissionRegistryMutationResult = z.infer<
  typeof permissionRegistryMutationResultSchema
>;
export type PermissionCatalogueLookupCommand = z.infer<
  typeof permissionCatalogueLookupCommandSchema
>;
export type PermissionCatalogueEntry = z.infer<typeof permissionCatalogueEntrySchema>;
export type PermissionCatalogueLookupResult = z.infer<typeof permissionCatalogueLookupResultSchema>;
export type ApplicationPermissionCatalogueSnapshot = z.infer<
  typeof applicationPermissionCatalogueSnapshotSchema
>;
export type PlatformPermissionCatalogue = z.infer<typeof platformPermissionCatalogueSchema>;
export type InitializePlatformPermissionCatalogueCommand = z.infer<
  typeof initializePlatformPermissionCatalogueCommandSchema
>;
export type InitializePlatformPermissionCatalogueResult = z.infer<
  typeof initializePlatformPermissionCatalogueResultSchema
>;
export type RevisePlatformPermissionCatalogueMetadataCommand = z.infer<
  typeof revisePlatformPermissionCatalogueMetadataCommandSchema
>;
export type RevisePlatformPermissionCatalogueMetadataResult = z.infer<
  typeof revisePlatformPermissionCatalogueMetadataResultSchema
>;
export type ApplicationPermissionCatalogueSnapshotCommand = z.infer<
  typeof applicationPermissionCatalogueSnapshotCommandSchema
>;
