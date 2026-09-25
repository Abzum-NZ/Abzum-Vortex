import "server-only";

import {
  applicationCompositionCatalogueSnapshotV2Schema,
  applicationCompositionPolicyV2Schema,
  connectionTypeIdSchema,
  connectionTypeSourceDocumentSchema,
  customComponentPlacementAllowedV2,
  customComponentReleaseV2Schema,
  namespacedKeySchema,
  platformBlockReferenceV2Schema,
  platformBlockReleaseV2Schema,
  platformThemeTokenRolesV2,
  PLATFORM_SERVICE_OPERATION_RELEASES,
  PLATFORM_SERVICE_OPERATIONS,
  platformIdSchema,
  platformThemeReleaseV2Schema,
  platformServiceOperationReleaseSchema,
  stableDefinitionReleaseVersionSchema,
  type ApplicationCompositionCatalogueSnapshotV2,
  type ApplicationCompositionPolicyV2,
  type BlockId,
  type ConnectionTypeId,
  type ConnectionTypeSourceDocument,
  type CustomComponentPlacementContextV2,
  type CustomComponentReleaseV2,
  type PlatformId,
  type PlatformBlockReleaseV2,
  type PlatformThemeReleaseV2,
  type PlatformThemeTokenRoleV2,
  type PlatformServiceOperationRelease,
  type SemanticVersion,
} from "@vortex/contracts";
import { compare } from "semver";
import { z } from "zod";
import { compareCanonicalStrings, fingerprintCanonicalValue } from "./canonical-json";
import {
  platformBlockReleaseFingerprints,
  platformServiceOperationReleaseFingerprints,
  platformThemeReleaseFingerprints,
} from "./catalogue-release-fingerprints";
import { compileDefinitionSet } from "./validation";
import type {
  DefinitionPublicationCatalogue,
  ResolvableConnectionTypeRelease,
} from "./definition-publication";

export type PlatformConnectionTypeReleaseDefinition = Readonly<{
  source: ConnectionTypeSourceDocument;
  rootId: ConnectionTypeId;
  releaseVersion: SemanticVersion;
}>;

export type ImmutableDefinitionPublicationCatalogueDefinition = Readonly<{
  connectionTypeReleases: readonly PlatformConnectionTypeReleaseDefinition[];
  applicationCompositionV2?: ApplicationCompositionCatalogueDefinitionV2;
  platformServiceOperationReleases?: readonly PlatformServiceOperationRelease[];
}>;

export type PlatformBlockReleaseDefinitionV2 = Omit<
  PlatformBlockReleaseV2,
  "contentFingerprint" | "catalogueFingerprint" | "customComponent"
>;

export type PlatformThemeReleaseDefinitionV2 = Omit<
  PlatformThemeReleaseV2,
  "contentFingerprint" | "catalogueFingerprint"
>;

export type CustomComponentReleaseDefinitionV2 = PlatformBlockReleaseDefinitionV2 &
  Readonly<{ customComponent: CustomComponentReleaseV2 }>;

export type ApplicationCompositionCatalogueDefinitionV2 = Readonly<{
  compositionPolicy: ApplicationCompositionPolicyV2;
  platformBlockReleases: readonly PlatformBlockReleaseDefinitionV2[];
  platformThemeReleases: readonly PlatformThemeReleaseDefinitionV2[];
  /**
   * Custom component releases owned by a customer application or module release. They are joined
   * with the platform block releases at materialisation and carry the same placement identity
   * shape, with the custom-component payload on top.
   */
  customComponentReleases?: readonly CustomComponentReleaseDefinitionV2[];
}>;

export type ApplicationCompositionCatalogueSelectionV2 = Readonly<{
  platformBlocks: readonly Readonly<{
    blockId: BlockId;
    releaseVersion: SemanticVersion;
  }>[];
  platformTheme: Readonly<{
    catalogueThemeId: PlatformId;
    releaseVersion: SemanticVersion;
  }>;
  /**
   * The placing application's key and exact bound module releases. A selected custom component
   * release is returned only when this context may place it, so an unrelated application never
   * receives a custom component it does not own or bind.
   */
  customComponentPlacement?: CustomComponentPlacementContextV2;
}>;

export interface ApplicationCompositionCatalogueV2 {
  readPlatformBlockReleaseV2(
    blockId: BlockId,
    releaseVersion: string,
  ): Promise<PlatformBlockReleaseV2 | undefined>;
  readPlatformThemeReleaseV2(
    catalogueThemeId: PlatformId,
    releaseVersion: string,
  ): Promise<PlatformThemeReleaseV2 | undefined>;
  readApplicationCompositionCatalogueSnapshotV2(
    selection: ApplicationCompositionCatalogueSelectionV2,
  ): Promise<ApplicationCompositionCatalogueSnapshotV2 | undefined>;
}

export type ImmutableDefinitionPublicationCatalogue = DefinitionPublicationCatalogue &
  ApplicationCompositionCatalogueV2;

const connectionTypeReleaseDefinitionSchema = z
  .object({
    source: connectionTypeSourceDocumentSchema,
    rootId: connectionTypeIdSchema,
    releaseVersion: stableDefinitionReleaseVersionSchema,
  })
  .strict();

// A platform block release never carries a custom component payload; custom component releases
// arrive only through `customComponentReleases`, where their ownership and bundle rules apply.
const platformBlockReleaseDefinitionV2Schema = z
  .object(platformBlockReleaseV2Schema.shape)
  .omit({ contentFingerprint: true, catalogueFingerprint: true, customComponent: true })
  .extend({ releaseVersion: stableDefinitionReleaseVersionSchema })
  .strict();

const platformThemeReleaseDefinitionV2Schema = z
  .object(platformThemeReleaseV2Schema.shape)
  .omit({ contentFingerprint: true, catalogueFingerprint: true })
  .extend({ releaseVersion: stableDefinitionReleaseVersionSchema })
  .strict();

const customComponentReleaseDefinitionV2Schema = platformBlockReleaseDefinitionV2Schema
  .extend({ customComponent: customComponentReleaseV2Schema })
  .strict();

const applicationCompositionCatalogueDefinitionV2Schema = z
  .object({
    compositionPolicy: applicationCompositionPolicyV2Schema,
    platformBlockReleases: z.array(platformBlockReleaseDefinitionV2Schema),
    platformThemeReleases: z.array(platformThemeReleaseDefinitionV2Schema),
    customComponentReleases: z.array(customComponentReleaseDefinitionV2Schema).max(10_000).optional(),
  })
  .strict();

const catalogueDefinitionSchema = z
  .object({
    connectionTypeReleases: z.array(connectionTypeReleaseDefinitionSchema).max(10_000),
    applicationCompositionV2: applicationCompositionCatalogueDefinitionV2Schema.optional(),
    platformServiceOperationReleases: z
      .array(platformServiceOperationReleaseSchema)
      .max(10_000)
      .optional(),
  })
  .strict();

const deepFreeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
};

const duplicate = (): never => {
  throw new Error("INVALID_PLATFORM_RELEASE_CATALOGUE");
};

const ensureUniqueConnectionTypeReleases = (
  connectionTypes: readonly PlatformConnectionTypeReleaseDefinition[],
): void => {
  const connectionVersions = new Set<string>();
  const rootsByKey = new Map<string, string>();
  const keysByRoot = new Map<string, string>();
  for (const release of connectionTypes) {
    const key = release.source.key;
    const rootId = String(release.rootId);
    const versionKey = `${key}:${release.releaseVersion}`;
    if (connectionVersions.has(versionKey)) duplicate();
    connectionVersions.add(versionKey);
    if (
      (rootsByKey.has(key) && rootsByKey.get(key) !== rootId) ||
      (keysByRoot.has(rootId) && keysByRoot.get(rootId) !== key)
    )
      duplicate();
    rootsByKey.set(key, rootId);
    keysByRoot.set(rootId, key);
  }
};

const ensureUniqueApplicationCompositionReleases = (
  definition: ApplicationCompositionCatalogueDefinitionV2 | undefined,
): void => {
  if (definition === undefined) return;
  const blockVersions = new Set<string>();
  const keysById = new Map<string, string>();
  const idsByKey = new Map<string, string>();
  for (const release of definition.platformBlockReleases) {
    const id = String(release.blockId);
    const versionKey = `${id}:${release.releaseVersion}`;
    if (
      blockVersions.has(versionKey) ||
      (keysById.has(id) && keysById.get(id) !== release.key) ||
      (idsByKey.has(release.key) && idsByKey.get(release.key) !== id)
    )
      duplicate();
    blockVersions.add(versionKey);
    keysById.set(id, release.key);
    idsByKey.set(release.key, id);
  }
  const themeVersions = new Set<string>();
  for (const release of definition.platformThemeReleases) {
    const versionKey = `${release.catalogueThemeId}:${release.releaseVersion}`;
    if (themeVersions.has(versionKey)) duplicate();
    themeVersions.add(versionKey);
  }
  // A custom component release joins the same identity space as the platform blocks but never
  // shares a block identity or key with a platform block, and every release of one custom component
  // keeps the same owner. Its typed contract is refused at materialisation when incomplete.
  const platformIds = new Set(keysById.keys());
  const platformKeys = new Set(idsByKey.keys());
  const customReleases = definition.customComponentReleases ?? [];
  const ownersById = new Map<string, string>();
  for (const release of customReleases) {
    const id = String(release.blockId);
    const versionKey = `${id}:${release.releaseVersion}`;
    const owner = release.customComponent.owner;
    const ownerIdentity = `${owner.kind}:${owner.definitionKey}`;
    if (
      platformIds.has(id) ||
      platformKeys.has(release.key) ||
      blockVersions.has(versionKey) ||
      (keysById.has(id) && keysById.get(id) !== release.key) ||
      (idsByKey.has(release.key) && idsByKey.get(release.key) !== id) ||
      (ownersById.has(id) && ownersById.get(id) !== ownerIdentity)
    )
      duplicate();
    blockVersions.add(versionKey);
    keysById.set(id, release.key);
    idsByKey.set(release.key, id);
    ownersById.set(id, ownerIdentity);
  }
  // Any bundle change is a major version change: two releases of one custom component that share
  // a major version must carry the identical bundle manifest.
  const bundlesByMajor = new Map<string, string>();
  for (const release of customReleases) {
    const major = release.releaseVersion.split(".")[0];
    const identity = `${String(release.blockId)}@${major}`;
    const bundle = fingerprintCanonicalValue(release.customComponent.bundle);
    if (bundlesByMajor.has(identity) && bundlesByMajor.get(identity) !== bundle) duplicate();
    bundlesByMajor.set(identity, bundle);
  }
};

/**
 * A platform theme release is complete only when it maps every role in the shared
 * token-role vocabulary with the kind that vocabulary requires, and marks each colour pair
 * with exactly the declared colour role (none where the vocabulary declares none). An
 * incomplete or mismarked release refuses here instead of publishing a theme that would
 * leave the renderer or the readability checks on another convention.
 */
const ensurePlatformThemeReleasesCoverEveryRole = (
  definition: ApplicationCompositionCatalogueDefinitionV2 | undefined,
): void => {
  if (definition === undefined) return;
  const roles: readonly PlatformThemeTokenRoleV2[] = platformThemeTokenRolesV2;
  for (const release of definition.platformThemeReleases) {
    for (const role of roles) {
      const token = release.tokens[role.key];
      if (
        token === undefined ||
        token.kind !== role.kind ||
        (token.kind === "color_pair" && token.role !== role.colorRole)
      )
        duplicate();
    }
  }
};

/**
 * The registered platform-service operations are published exactly as registered: each release's
 * content fingerprint must be the canonical-JSON SHA-256 of its descriptor and its catalogue
 * fingerprint that of its identity and content, so a descriptor edited without a new release
 * refuses instead of silently changing what an Application published against.
 */
const ensureRegisteredPlatformServiceOperationsAuthentic = (): void => {
  for (const { release, descriptor } of Object.values(PLATFORM_SERVICE_OPERATIONS)) {
    const expected = platformServiceOperationReleaseFingerprints(release, descriptor);
    if (
      descriptor.operation.owner.kind !== "platform_service" ||
      descriptor.operation.owner.serviceId !== release.serviceId ||
      descriptor.operation.operationId !== release.operationId ||
      release.contentFingerprint !== expected.contentFingerprint ||
      release.catalogueFingerprint !== expected.catalogueFingerprint
    )
      duplicate();
  }
};

const compileConnectionTypeRelease = (
  definition: PlatformConnectionTypeReleaseDefinition,
): ResolvableConnectionTypeRelease => {
  const definitions = [
    {
      kind: "connection_type" as const,
      key: definition.source.key,
      rootId: definition.rootId,
      exactVersion: definition.releaseVersion,
      operationKeys: definition.source.body.operations.map((operation) => operation.key),
    },
  ];
  const resolutionEvidence = {
    contractVersion: "1.0.0" as const,
    definitions,
    identities: [],
  };
  const compilationOutput = compileDefinitionSet(
    [
      {
        source: definition.source,
        resolution: {
          ...resolutionEvidence,
          fingerprint: fingerprintCanonicalValue(resolutionEvidence),
        },
      },
    ],
    { publishedHistories: [] },
  )[0];
  const connectionOutput =
    compilationOutput?.kind === "connection_type" ? compilationOutput : duplicate();
  const catalogueFingerprint = fingerprintCanonicalValue({
    kind: "connection_type",
    key: definition.source.key,
    rootId: definition.rootId,
    releaseVersion: definition.releaseVersion,
    sourceFingerprint: fingerprintCanonicalValue(definition.source),
  });
  return deepFreeze({
    key: definition.source.key,
    rootId: definition.rootId,
    releaseVersion: definition.releaseVersion,
    contentFingerprint: connectionOutput.artifact.contentFingerprint,
    catalogueFingerprint,
    compilationOutput: connectionOutput,
  });
};

const materialisePlatformBlockReleaseV2 = (
  definition: PlatformBlockReleaseDefinitionV2,
): PlatformBlockReleaseV2 => {
  return deepFreeze(
    platformBlockReleaseV2Schema.parse({
      ...definition,
      ...platformBlockReleaseFingerprints(definition),
    }),
  );
};

const materialisePlatformThemeReleaseV2 = (
  definition: PlatformThemeReleaseDefinitionV2,
): PlatformThemeReleaseV2 => {
  return deepFreeze(
    platformThemeReleaseV2Schema.parse({
      ...definition,
      ...platformThemeReleaseFingerprints(definition),
    }),
  );
};

/**
 * Creates the read-only publication catalogue used until durable platform-catalogue storage exists.
 * Connection releases are compiled from the governed source contract; platform block and theme
 * releases are the current Application composition catalogue, each represented by its exact
 * immutable content fingerprint.
 */
export const createImmutableDefinitionPublicationCatalogue = (
  input: ImmutableDefinitionPublicationCatalogueDefinition,
): ImmutableDefinitionPublicationCatalogue => {
  const parsed = catalogueDefinitionSchema.safeParse(input);
  const definition = parsed.success ? parsed.data : duplicate();
  ensureUniqueConnectionTypeReleases(definition.connectionTypeReleases);
  ensureUniqueApplicationCompositionReleases(definition.applicationCompositionV2);
  ensurePlatformThemeReleasesCoverEveryRole(definition.applicationCompositionV2);
  ensureRegisteredPlatformServiceOperationsAuthentic();
  const operationReleases = [
    ...PLATFORM_SERVICE_OPERATION_RELEASES,
    ...(definition.platformServiceOperationReleases ?? []),
  ];
  const operationIdentities = new Set(
    operationReleases.map(
      (release) => `${release.serviceId}:${release.operationId}:${release.releaseVersion}`,
    ),
  );
  if (operationIdentities.size !== operationReleases.length) duplicate();

  const connectionTypes = definition.connectionTypeReleases
    .map((release) => compileConnectionTypeRelease(release))
    .sort((left, right) =>
      left.key === right.key
        ? compare(left.releaseVersion, right.releaseVersion)
        : compareCanonicalStrings(left.key, right.key),
    );
  const connectionsByKey = new Map<string, readonly ResolvableConnectionTypeRelease[]>();
  for (const release of connectionTypes)
    connectionsByKey.set(release.key, [...(connectionsByKey.get(release.key) ?? []), release]);
  for (const [key, releases] of connectionsByKey) connectionsByKey.set(key, deepFreeze(releases));
  const connectionsByIdentity = new Map(
    connectionTypes.map((release) => [`${release.rootId}:${release.releaseVersion}`, release]),
  );
  const composition = definition.applicationCompositionV2;
  const blockReleasesV2 = [
    ...(composition?.platformBlockReleases ?? []).map(materialisePlatformBlockReleaseV2),
    ...(composition?.customComponentReleases ?? []).map(materialisePlatformBlockReleaseV2),
  ];
  const themeReleasesV2 = (composition?.platformThemeReleases ?? []).map(
    materialisePlatformThemeReleaseV2,
  );
  const blocksV2ByIdentity = new Map(
    blockReleasesV2.map((release) => [`${release.blockId}:${release.releaseVersion}`, release]),
  );
  const themesV2ByIdentity = new Map(
    themeReleasesV2.map((release) => [
      `${release.catalogueThemeId}:${release.releaseVersion}`,
      release,
    ]),
  );
  const operationsByIdentity = new Map(
    operationReleases.map((release) => [
      `${release.serviceId}:${release.operationId}:${release.releaseVersion}`,
      deepFreeze({ ...release }),
    ]),
  );

  const readPlatformBlockReleaseV2 = async (blockId: BlockId, releaseVersion: string) =>
    blocksV2ByIdentity.get(`${blockId}:${releaseVersion}`);
  const readPlatformThemeReleaseV2 = async (catalogueThemeId: PlatformId, releaseVersion: string) =>
    themesV2ByIdentity.get(`${catalogueThemeId}:${releaseVersion}`);

  return Object.freeze({
    listConnectionTypeReleases: async (key: string) => connectionsByKey.get(key) ?? [],
    readConnectionTypeRelease: async (rootId: ConnectionTypeId, releaseVersion: string) =>
      connectionsByIdentity.get(`${rootId}:${releaseVersion}`),
    readPlatformBlockReleaseV2,
    readPlatformThemeReleaseV2,
    readPlatformServiceOperationRelease: async (
      serviceId: string,
      operationId: string,
      releaseVersion: string,
    ) => operationsByIdentity.get(`${serviceId}:${operationId}:${releaseVersion}`),
    readApplicationCompositionCatalogueSnapshotV2: async (
      selection: ApplicationCompositionCatalogueSelectionV2,
    ) => {
      if (composition === undefined) return undefined;
      const parsedSelection = z
        .object({
          platformBlocks: z.array(platformBlockReferenceV2Schema),
          platformTheme: z
            .object({
              catalogueThemeId: platformIdSchema,
              releaseVersion: stableDefinitionReleaseVersionSchema,
            })
            .strict(),
          customComponentPlacement: z
            .object({
              applicationKey: namespacedKeySchema,
              boundModuleReleases: z
                .array(
                  z
                    .object({
                      moduleKey: namespacedKeySchema,
                      releaseVersion: stableDefinitionReleaseVersionSchema,
                    })
                    .strict(),
                )
                .max(1_000),
            })
            .strict()
            .optional(),
        })
        .strict()
        .safeParse(selection);
      if (!parsedSelection.success) return undefined;
      const selectedBlockIdentities = parsedSelection.data.platformBlocks.map(
        (reference) => `${reference.blockId}@${reference.releaseVersion}`,
      );
      if (new Set(selectedBlockIdentities).size !== selectedBlockIdentities.length)
        return undefined;
      const selectedBlocks = await Promise.all(
        parsedSelection.data.platformBlocks.map((reference) =>
          readPlatformBlockReleaseV2(reference.blockId, reference.releaseVersion),
        ),
      );
      if (selectedBlocks.some((release) => release === undefined)) return undefined;
      // A custom component is returned only to the application that owns it or that binds the
      // exact owning module release; any other application never receives it, so its placement is
      // refused rather than silently allowed.
      for (const release of selectedBlocks as PlatformBlockReleaseV2[]) {
        const custom = release.customComponent;
        if (custom === undefined) continue;
        const context = parsedSelection.data.customComponentPlacement;
        if (context === undefined || !customComponentPlacementAllowedV2(custom.owner, context))
          return undefined;
      }
      const selectedTheme = await readPlatformThemeReleaseV2(
        parsedSelection.data.platformTheme.catalogueThemeId,
        parsedSelection.data.platformTheme.releaseVersion,
      );
      if (selectedTheme === undefined) return undefined;
      const releases = (selectedBlocks as PlatformBlockReleaseV2[]).sort((left, right) =>
        compareCanonicalStrings(
          `${left.blockId}@${left.releaseVersion}`,
          `${right.blockId}@${right.releaseVersion}`,
        ),
      );
      const evidence = {
        contractVersion: "2.0.0" as const,
        platformBlocks: {
          compositionPolicy: composition.compositionPolicy,
          releases,
        },
        platformTheme: selectedTheme,
      };
      return deepFreeze(
        applicationCompositionCatalogueSnapshotV2Schema.parse({
          ...evidence,
          fingerprint: fingerprintCanonicalValue(evidence),
        }),
      );
    },
  });
};
