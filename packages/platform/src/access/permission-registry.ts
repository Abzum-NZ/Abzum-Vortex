import { z } from "zod";
import { correlationIdSchema } from "../catalogue/common";
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
} from "../catalogue/identifiers";
import { permissionDeclarationSchema } from "./permissions";
import { stableDefinitionReleaseVersionSchema } from "../definition/version-impact";

const permissionRegistryDefinitionReleaseCommon = {
  definitionKey: namespacedKeySchema,
  releaseRevision: revisionSchema,
  releaseVersion: stableDefinitionReleaseVersionSchema,
  validationContractVersion: semanticVersionSchema,
};

export const permissionRegistrySourceRevisionSchema = z.discriminatedUnion("kind", [
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

const permissionRegistryDefinitionReleaseFingerprints = {
  contentFingerprint: fingerprintSchema,
  resolutionFingerprint: fingerprintSchema,
};

export const permissionRegistryDefinitionReleaseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("application"),
      rootId: applicationRootIdSchema,
      ...permissionRegistryDefinitionReleaseCommon,
      ...permissionRegistryDefinitionReleaseFingerprints,
    })
    .strict(),
  z
    .object({
      kind: z.literal("module"),
      rootId: moduleRootIdSchema,
      ...permissionRegistryDefinitionReleaseCommon,
      ...permissionRegistryDefinitionReleaseFingerprints,
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
        expectedRevision: revisionSchema,
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
      expectedRevision: revisionSchema,
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
    registrationRevision: revisionSchema,
    accessVersion: revisionSchema,
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
