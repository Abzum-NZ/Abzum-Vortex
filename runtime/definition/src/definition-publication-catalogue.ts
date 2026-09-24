import "server-only";

import {
  applicationCompositionCatalogueSnapshotV2Schema,
  applicationCompositionPolicyV2Schema,
  connectionTypeIdSchema,
  connectionTypeSourceDocumentSchema,
  platformBlockReferenceV2Schema,
  platformBlockReleaseV2Schema,
  platformThemeTokenRolesV2,
  PLATFORM_SERVICE_OPERATION_RELEASES,
  PLATFORM_SERVICE_OPERATIONS,
  platformIdSchema,
  platformThemeReleaseV2Schema,
  platformManagedFlowDependencySchema,
  platformServiceOperationReleaseSchema,
  stableDefinitionReleaseVersionSchema,
  type ApplicationCompositionCatalogueSnapshotV2,
  type ApplicationCompositionPolicyV2,
  type BlockId,
  type ConnectionTypeId,
  type ConnectionTypeSourceDocument,
  type PlatformId,
  type PlatformBlockReleaseV2,
  type PlatformThemeReleaseV2,
  type PlatformThemeTokenRoleV2,
  type PlatformManagedFlowDependency,
  type PlatformServiceOperationRelease,
  type SemanticVersion,
} from "@vortex/contracts";
import { compare } from "semver";
import { z } from "zod";
import { compareCanonicalStrings, fingerprintCanonicalValue } from "./canonical-json";
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
  platformManagedFlowReleases?: readonly PlatformManagedFlowDependency[];
  platformServiceOperationReleases?: readonly PlatformServiceOperationRelease[];
}>;

export type PlatformBlockReleaseDefinitionV2 = Omit<
  PlatformBlockReleaseV2,
  "contentFingerprint" | "catalogueFingerprint"
>;

export type PlatformThemeReleaseDefinitionV2 = Omit<
  PlatformThemeReleaseV2,
  "contentFingerprint" | "catalogueFingerprint"
>;

export type ApplicationCompositionCatalogueDefinitionV2 = Readonly<{
  compositionPolicy: ApplicationCompositionPolicyV2;
  platformBlockReleases: readonly PlatformBlockReleaseDefinitionV2[];
  platformThemeReleases: readonly PlatformThemeReleaseDefinitionV2[];
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

const platformBlockReleaseDefinitionV2Schema = z
  .object(platformBlockReleaseV2Schema.shape)
  .omit({ contentFingerprint: true, catalogueFingerprint: true })
  .extend({ releaseVersion: stableDefinitionReleaseVersionSchema })
  .strict();

const platformThemeReleaseDefinitionV2Schema = z
  .object(platformThemeReleaseV2Schema.shape)
  .omit({ contentFingerprint: true, catalogueFingerprint: true })
  .extend({ releaseVersion: stableDefinitionReleaseVersionSchema })
  .strict();

const applicationCompositionCatalogueDefinitionV2Schema = z
  .object({
    compositionPolicy: applicationCompositionPolicyV2Schema,
    platformBlockReleases: z.array(platformBlockReleaseDefinitionV2Schema),
    platformThemeReleases: z.array(platformThemeReleaseDefinitionV2Schema),
  })
  .strict();

const catalogueDefinitionSchema = z
  .object({
    connectionTypeReleases: z.array(connectionTypeReleaseDefinitionSchema).max(10_000),
    applicationCompositionV2: applicationCompositionCatalogueDefinitionV2Schema.optional(),
    platformManagedFlowReleases: z
      .array(platformManagedFlowDependencySchema)
      .max(10_000)
      .optional(),
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
    const contentFingerprint = fingerprintCanonicalValue(descriptor);
    if (
      descriptor.operation.owner.kind !== "platform_service" ||
      descriptor.operation.owner.serviceId !== release.serviceId ||
      descriptor.operation.operationId !== release.operationId ||
      release.contentFingerprint !== contentFingerprint ||
      release.catalogueFingerprint !==
        fingerprintCanonicalValue({
          kind: "platform_service_operation",
          serviceId: release.serviceId,
          operationId: release.operationId,
          releaseVersion: release.releaseVersion,
          contentFingerprint,
        })
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
  const content = {
    name: definition.name,
    icon: definition.icon,
    paletteGroup: definition.paletteGroup,
    rendererKey: definition.rendererKey,
    properties: definition.properties,
    slots: definition.slots,
    capabilities: definition.capabilities,
    supportedEvents: definition.supportedEvents,
    supportedStateOperations: definition.supportedStateOperations,
  };
  const contentFingerprint = fingerprintCanonicalValue(content);
  return deepFreeze(
    platformBlockReleaseV2Schema.parse({
      ...definition,
      contentFingerprint,
      catalogueFingerprint: fingerprintCanonicalValue({
        kind: "platform_block",
        blockId: definition.blockId,
        key: definition.key,
        releaseVersion: definition.releaseVersion,
        contentFingerprint,
      }),
    }),
  );
};

const materialisePlatformThemeReleaseV2 = (
  definition: PlatformThemeReleaseDefinitionV2,
): PlatformThemeReleaseV2 => {
  const contentFingerprint = fingerprintCanonicalValue(definition.tokens);
  return deepFreeze(
    platformThemeReleaseV2Schema.parse({
      ...definition,
      contentFingerprint,
      catalogueFingerprint: fingerprintCanonicalValue({
        kind: "platform_theme",
        catalogueThemeId: definition.catalogueThemeId,
        releaseVersion: definition.releaseVersion,
        contentFingerprint,
      }),
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
  const managedFlowReleases = definition.platformManagedFlowReleases ?? [];
  const managedFlowIdentities = new Set(
    managedFlowReleases.map((release) => `${release.flowId}:${release.releaseVersion}`),
  );
  if (managedFlowIdentities.size !== managedFlowReleases.length) duplicate();
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
  const blockReleasesV2 = (composition?.platformBlockReleases ?? []).map(
    materialisePlatformBlockReleaseV2,
  );
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
  const managedFlowsByIdentity = new Map(
    managedFlowReleases.map((release) => [
      `${release.flowId}:${release.releaseVersion}`,
      deepFreeze({ ...release }),
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
    readPlatformManagedFlowRelease: async (flowId: string, releaseVersion: string) =>
      managedFlowsByIdentity.get(`${flowId}:${releaseVersion}`),
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
        })
        .strict()
        .safeParse(selection);
      if (!parsedSelection.success) return undefined;
      const selectedBlockIds = parsedSelection.data.platformBlocks.map((reference) =>
        String(reference.blockId),
      );
      if (new Set(selectedBlockIds).size !== selectedBlockIds.length) return undefined;
      const selectedBlocks = await Promise.all(
        parsedSelection.data.platformBlocks.map((reference) =>
          readPlatformBlockReleaseV2(reference.blockId, reference.releaseVersion),
        ),
      );
      if (selectedBlocks.some((release) => release === undefined)) return undefined;
      const selectedTheme = await readPlatformThemeReleaseV2(
        parsedSelection.data.platformTheme.catalogueThemeId,
        parsedSelection.data.platformTheme.releaseVersion,
      );
      if (selectedTheme === undefined) return undefined;
      const releases = (selectedBlocks as PlatformBlockReleaseV2[]).sort((left, right) =>
        compareCanonicalStrings(String(left.blockId), String(right.blockId)),
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
