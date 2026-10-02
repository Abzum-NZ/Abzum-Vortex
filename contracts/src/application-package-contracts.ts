import { z } from "zod";
import { applicationRoleSchema } from "./application-contracts";
import {
  applicationCompilationOutputV2Schema,
  applicationToolBundleSchema,
  definitionResolutionSnapshotV2Schema,
  definitionResolutionSnapshotV3Schema,
  moduleCompilationOutputV3Schema,
} from "./definition-compilation-contracts";
import { applicationPlatformCompatibilityVersionSchema } from "./platform-compatibility";
import { exactDefinitionDependencySchema } from "./definition-store-contracts";
import { flowIdSchema } from "./flow-contracts";
import { canonicalJson, compareCanonicalStrings } from "./canonical-json";
import {
  applicationRootIdSchema,
  blockIdSchema,
  builderKeySchema,
  fingerprintSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  organizationIdSchema,
  platformIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  storageContractIdSchema,
} from "./identifiers";
import { moduleSystemProjectionV3Schema } from "./module-contracts-v3";
import {
  permissionDeclarationSchema,
  permissionRecordScopeSchema,
  permissionSavedConditionRestrictionSchema,
} from "./permissions";
import {
  customComponentDataContractV2Schema,
  customComponentEventV2Schema,
  customComponentOwnerV2Schema,
  customComponentBundleV2Schema,
  platformBlockReleaseV2Schema,
  platformThemeReleaseV2Schema,
} from "./application-composition-v2";
import { stableDefinitionReleaseVersionSchema } from "./version-impact";

const applicationReleaseIdentitySchema = z
  .object({
    kind: z.literal("application"),
    organizationId: organizationIdSchema,
    rootId: applicationRootIdSchema,
    releaseRevision: revisionSchema,
    releaseVersion: stableDefinitionReleaseVersionSchema,
    contentFingerprint: fingerprintSchema,
    resolutionFingerprint: fingerprintSchema,
  })
  .strict();

const moduleReleaseIdentitySchema = z
  .object({
    kind: z.literal("module"),
    organizationId: organizationIdSchema,
    rootId: moduleRootIdSchema,
    releaseRevision: revisionSchema,
    releaseVersion: stableDefinitionReleaseVersionSchema,
    contentFingerprint: fingerprintSchema,
    resolutionFingerprint: fingerprintSchema,
  })
  .strict();

export const applicationPackageApplicationEvidenceSchema = z
  .object({
    release: applicationReleaseIdentitySchema,
    compilationOutput: applicationCompilationOutputV2Schema,
    resolutionSnapshot: definitionResolutionSnapshotV2Schema,
    dependencyManifest: z.array(exactDefinitionDependencySchema).max(10_000),
  })
  .strict();

export const applicationPackageModuleEvidenceSchema = z
  .object({
    release: moduleReleaseIdentitySchema,
    compilationOutput: moduleCompilationOutputV3Schema,
    resolutionSnapshot: definitionResolutionSnapshotV3Schema,
    dependencyManifest: z.array(exactDefinitionDependencySchema).max(10_000),
  })
  .strict();

/** Exact compiler and immutable release evidence supplied by the authorized publication caller. */
export const applicationPackageManifestInputSchema = z
  .object({
    application: applicationPackageApplicationEvidenceSchema,
    modules: z.array(applicationPackageModuleEvidenceSchema).max(10_000),
    selectedBlockReleases: z.array(platformBlockReleaseV2Schema).max(10_000),
    selectedThemeRelease: platformThemeReleaseV2Schema,
  })
  .strict();

const ownerSchema = z.discriminatedUnion("kind", [
  applicationReleaseIdentitySchema,
  moduleReleaseIdentitySchema,
]);

const roleDeclarationSchema = z
  .object({ owner: ownerSchema, declaration: applicationRoleSchema })
  .strict()
  .superRefine((value, context) => {
    if (
      value.declaration.permissionKeys.some(
        (key, index) => index > 0 && compareCanonicalStrings(value.declaration.permissionKeys[index - 1]!, key) >= 0,
      )
    )
      context.addIssue({ code: "custom", path: ["declaration", "permissionKeys"], message: "Role permissions must use canonical order" });
  });

/**
 * Package declarations preserve the complete supported permission meaning. Literal saved-condition
 * bindings are unsupported: arbitrary JSON values are not package declaration metadata. Refuse
 * them instead of removing a restriction or copying customer payload into the manifest.
 */
// Validate the same input against both complete permission semantics and the closed metadata
// profile. An intersection preserves branded output identities without piping raw schema inputs.
export const applicationPackagePermissionDeclarationSchema = z.intersection(
  permissionDeclarationSchema,
  z
    .object({
      ...permissionDeclarationSchema.shape,
      recordScope: z
        .object({
          ...permissionRecordScopeSchema.shape,
          savedCondition: z
            .object({
              ...permissionSavedConditionRestrictionSchema.shape,
              parameterBindings: z.array(
                z.object({
                  key: builderKeySchema,
                  source: z.literal("current_organization_account_id"),
                }).strict(),
              ).max(10_000),
            })
            .strict()
            .optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
);

const permissionDeclarationEntrySchema = z
  .object({ owner: ownerSchema, declaration: applicationPackagePermissionDeclarationSchema })
  .strict();

const flowDeclarationSchema = z
  .object({
    owner: ownerSchema,
    flowId: flowIdSchema,
    key: builderKeySchema,
  })
  .strict();

const storageDeclarationSchema = z
  .object({
    owner: ownerSchema,
    recordTypeId: recordTypeIdSchema,
    key: builderKeySchema,
    storageContractId: storageContractIdSchema,
    storageScope: z.enum(["organization_shared", "application_contained"]),
    storageKind: z.enum(["generated", "system_projection"]),
    systemProjection: moduleSystemProjectionV3Schema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.storageKind === "system_projection") !== (value.systemProjection !== undefined))
      context.addIssue({ code: "custom", path: ["systemProjection"], message: "Storage meaning must match its projection declaration" });
    if (
      value.systemProjection !== undefined &&
      [value.systemProjection.filterableFieldIds, value.systemProjection.sortableFieldIds].some((ids) =>
        ids.some((id, index) => index > 0 && compareCanonicalStrings(ids[index - 1]!, id) >= 0),
      )
    )
      context.addIssue({ code: "custom", path: ["systemProjection"], message: "Projection field sets must use canonical order" });
  });

const blockDeclarationSchema = z
  .object({
    blockId: blockIdSchema,
    key: namespacedKeySchema,
    releaseVersion: stableDefinitionReleaseVersionSchema,
    contentFingerprint: fingerprintSchema,
    catalogueFingerprint: fingerprintSchema,
    customComponent: z
      .object({
        owner: customComponentOwnerV2Schema,
        events: z.array(customComponentEventV2Schema).max(50),
        dataContract: customComponentDataContractV2Schema,
        textAlternative: z.string().min(1).max(200),
        bundle: customComponentBundleV2Schema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hosts = value.customComponent?.bundle.allowedHosts;
    if (hosts?.some((host, index) => index > 0 && compareCanonicalStrings(hosts[index - 1]!, host) >= 0))
      context.addIssue({ code: "custom", path: ["customComponent", "bundle", "allowedHosts"], message: "Component hosts must use canonical order" });
  });

const themeDeclarationSchema = z
  .object({
    catalogueThemeId: platformIdSchema,
    releaseVersion: stableDefinitionReleaseVersionSchema,
    contentFingerprint: fingerprintSchema,
    catalogueFingerprint: fingerprintSchema,
  })
  .strict();

type PackageDependency = z.infer<typeof exactDefinitionDependencySchema>;

/** Permanent subject order shared by the builder and the strict output contract. */
export const applicationPackageDependencySubject = (dependency: PackageDependency): string => {
  const entry = dependency as unknown as Record<string, unknown>;
  if (entry.kind === "platform_theme" && typeof entry.catalogueThemeId === "string")
    return `platform_theme:${entry.catalogueThemeId.toLowerCase()}`;
  if (entry.kind === "platform_block" && typeof entry.blockId === "string")
    return `platform_block:${entry.blockId.toLowerCase()}@${String(entry.releaseVersion)}`;
  if ((entry.kind === "module" || entry.kind === "connection_type") && typeof entry.rootId === "string")
    return `${String(entry.kind)}:${entry.rootId.toLowerCase()}`;
  if (typeof entry.applicationRootId === "string") {
    const target =
      typeof entry.nodeId === "string"
        ? `${String(entry.flowId)}:${entry.nodeId}`
        : typeof entry.flowId === "string"
          ? entry.flowId
          : typeof entry.queryId === "string"
            ? entry.queryId
            : typeof entry.formId === "string"
              ? entry.formId
              : typeof entry.workflowId === "string"
                ? entry.workflowId
                : typeof entry.actionId === "string"
                  ? entry.actionId
                  : canonicalJson(dependency);
    return `${String(entry.kind)}:${entry.applicationRootId.toLowerCase()}:${target.toLowerCase()}`;
  }
  if (typeof entry.moduleRootId === "string")
    return `${String(entry.kind)}:${entry.moduleRootId.toLowerCase()}:${String(entry.queryId ?? entry.key).toLowerCase()}`;
  if (entry.kind === "protected_operation" && typeof entry.operation === "object" && entry.operation !== null) {
    const operation = entry.operation as Record<string, unknown>;
    const owner = operation.owner as Record<string, unknown> | undefined;
    const ownerId = owner?.applicationRootId ?? owner?.moduleRootId ?? owner?.serviceId;
    return `${String(entry.kind)}:${String(owner?.kind)}:${String(ownerId).toLowerCase()}:${String(operation.operationId).toLowerCase()}`;
  }
  return `${String(entry.kind)}:${typeof entry.key === "string" ? entry.key : canonicalJson(dependency)}`;
};

export const applicationPackageManifestSchema = z
  .object({
    manifestKind: z.literal("application_package"),
    manifestVersion: z.literal("1.0.0"),
    application: applicationReleaseIdentitySchema,
    platformCompatibilityVersion: applicationPlatformCompatibilityVersionSchema,
    modules: z.array(moduleReleaseIdentitySchema).max(10_000),
    dependencies: z.array(exactDefinitionDependencySchema).max(10_000),
    roles: z.array(roleDeclarationSchema).max(10_000),
    permissions: z.array(permissionDeclarationEntrySchema).max(10_000),
    storage: z.array(storageDeclarationSchema).max(10_000),
    flows: z.array(flowDeclarationSchema).max(10_000),
    tools: z
      .object({ bundle: applicationToolBundleSchema, checksum: fingerprintSchema })
      .strict(),
    blocks: z.array(blockDeclarationSchema).max(10_000),
    componentHosts: z.array(z.string().min(1).max(253)).max(10_000),
    componentsPresent: z.boolean(),
    theme: themeDeclarationSchema,
    assets: z
      .object({ support: z.literal("unsupported"), referenceCount: z.literal(0) })
      .strict(),
    seeds: z
      .object({ support: z.literal("unsupported"), recordCount: z.literal(0) })
      .strict(),
    scripts: z
      .object({
        support: z.literal("unsupported"),
        referencesPresent: z.literal(false),
        acceptedTaskRegistryFingerprint: fingerprintSchema,
      })
      .strict(),
    fingerprint: fingerprintSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    const checkUniqueCanonical = <Value>(
      values: readonly Value[],
      keyOf: (value: Value) => string,
      path: string,
    ) => {
      const keys = values.map(keyOf);
      if (new Set(keys).size !== keys.length)
        context.addIssue({ code: "custom", path: [path], message: "Manifest subjects must be unique" });
      if (keys.some((key, index) => index > 0 && compareCanonicalStrings(keys[index - 1]!, key) >= 0))
        context.addIssue({ code: "custom", path: [path], message: "Manifest subjects must use canonical order" });
    };
    checkUniqueCanonical(manifest.modules, (module) => module.rootId.toLowerCase(), "modules");
    checkUniqueCanonical(
      manifest.roles,
      (entry) => `${entry.owner.rootId.toLowerCase()}:${entry.declaration.roleId.toLowerCase()}`,
      "roles",
    );
    checkUniqueCanonical(
      manifest.permissions,
      (entry) => `${entry.owner.rootId.toLowerCase()}:${entry.declaration.permissionId.toLowerCase()}`,
      "permissions",
    );
    checkUniqueCanonical(
      manifest.storage,
      (entry) => `${entry.owner.rootId.toLowerCase()}:${entry.recordTypeId.toLowerCase()}`,
      "storage",
    );
    checkUniqueCanonical(
      manifest.flows,
      (entry) => `${entry.owner.rootId.toLowerCase()}:${entry.flowId.toLowerCase()}`,
      "flows",
    );
    checkUniqueCanonical(
      manifest.blocks,
      (entry) => `${entry.blockId.toLowerCase()}@${entry.releaseVersion}`,
      "blocks",
    );
    checkUniqueCanonical(manifest.componentHosts, (host) => host, "componentHosts");
    checkUniqueCanonical(manifest.dependencies, applicationPackageDependencySubject, "dependencies");
    if (manifest.componentsPresent !== manifest.blocks.some((block) => block.customComponent !== undefined))
      context.addIssue({ code: "custom", path: ["componentsPresent"], message: "Component presence must match selected block evidence" });

    const moduleDependencies = manifest.dependencies.filter(
      (dependency): dependency is Extract<PackageDependency, { kind: "module" }> => dependency.kind === "module",
    );
    const moduleByIdentity = new Map<string, z.infer<typeof moduleReleaseIdentitySchema>>(
      manifest.modules.map((module) => [`${module.rootId.toLowerCase()}@${module.releaseVersion}`, module] as const),
    );
    if (
      manifest.modules.some((module) => module.organizationId.toLowerCase() !== manifest.application.organizationId.toLowerCase()) ||
      moduleDependencies.length !== manifest.modules.length ||
      moduleDependencies.some((dependency) => {
        const module = moduleByIdentity.get(`${dependency.rootId.toLowerCase()}@${dependency.releaseVersion}`);
        return module === undefined ||
          module.organizationId.toLowerCase() !== manifest.application.organizationId.toLowerCase() ||
          module.rootId.toLowerCase() !== dependency.rootId.toLowerCase() ||
          module.releaseRevision !== dependency.releaseRevision ||
          module.releaseVersion !== dependency.releaseVersion ||
          module.contentFingerprint !== dependency.contentFingerprint ||
          module.resolutionFingerprint !== dependency.resolutionFingerprint;
      })
    )
      context.addIssue({ code: "custom", path: ["modules"], message: "Module closure must match exact dependency evidence" });

    const ownerIsPresent = (owner: z.infer<typeof ownerSchema>): boolean =>
      owner.kind === "application"
        ? canonicalJson(owner) === canonicalJson(manifest.application)
        : manifest.modules.some((module) => canonicalJson(owner) === canonicalJson(module));
    if (manifest.roles.some((entry) => canonicalJson(entry.owner) !== canonicalJson(manifest.application)))
      context.addIssue({ code: "custom", path: ["roles"], message: "Application roles must retain their exact owner" });
    if (manifest.permissions.some((entry) => !ownerIsPresent(entry.owner)))
      context.addIssue({ code: "custom", path: ["permissions"], message: "Permissions must retain an exact package owner" });
    if (manifest.flows.some((entry) => !ownerIsPresent(entry.owner)))
      context.addIssue({ code: "custom", path: ["flows"], message: "Flows must retain an exact package owner" });
    if (manifest.storage.some((entry) => entry.owner.kind !== "module" || !ownerIsPresent(entry.owner)))
      context.addIssue({ code: "custom", path: ["storage"], message: "Storage declarations must retain an exact Module owner" });
    const permissionKeys = new Set(manifest.permissions.map((entry) => entry.declaration.key));
    if (manifest.roles.some((entry) => entry.declaration.permissionKeys.some((key) => !permissionKeys.has(key))))
      context.addIssue({ code: "custom", path: ["roles"], message: "Role selections must name declared package permissions" });

    const blockDependencies = manifest.dependencies.filter(
      (dependency): dependency is Extract<PackageDependency, { kind: "platform_block" }> => dependency.kind === "platform_block",
    );
    if (
      blockDependencies.length !== manifest.blocks.length ||
      blockDependencies.some((dependency) => !manifest.blocks.some((block) =>
        block.blockId.toLowerCase() === dependency.blockId.toLowerCase() &&
        block.releaseVersion === dependency.releaseVersion &&
        block.contentFingerprint === dependency.contentFingerprint &&
        block.catalogueFingerprint === dependency.catalogueFingerprint,
      ))
    )
      context.addIssue({ code: "custom", path: ["blocks"], message: "Block declarations must match exact selected releases" });
    const themeDependencies = manifest.dependencies.filter((dependency) => dependency.kind === "platform_theme");
    if (
      themeDependencies.length !== 1 ||
      themeDependencies[0]!.catalogueThemeId.toLowerCase() !== manifest.theme.catalogueThemeId.toLowerCase() ||
      themeDependencies[0]!.releaseVersion !== manifest.theme.releaseVersion ||
      themeDependencies[0]!.contentFingerprint !== manifest.theme.contentFingerprint ||
      themeDependencies[0]!.catalogueFingerprint !== manifest.theme.catalogueFingerprint
    )
      context.addIssue({ code: "custom", path: ["theme"], message: "Theme declaration must match exact selected release evidence" });
    const declaredHosts = [...new Set(manifest.blocks.flatMap((block) => block.customComponent?.bundle.allowedHosts ?? []))]
      .sort(compareCanonicalStrings);
    if (canonicalJson(declaredHosts) !== canonicalJson(manifest.componentHosts))
      context.addIssue({ code: "custom", path: ["componentHosts"], message: "Component hosts must be the canonical selected-release union" });
  });

export type ApplicationPackageManifestInput = z.infer<typeof applicationPackageManifestInputSchema>;
export type ApplicationPackageManifest = z.infer<typeof applicationPackageManifestSchema>;

// Keep these imported declarations anchored to the exact canonical storage and block contracts.
export type ApplicationPackageSystemProjection = z.infer<typeof moduleSystemProjectionV3Schema>;
