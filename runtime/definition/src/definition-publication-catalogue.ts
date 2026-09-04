import "server-only";

import {
  connectionTypeIdSchema,
  connectionTypeSourceDocumentSchema,
  fingerprintSchema,
  platformIdSchema,
  stableDefinitionReleaseVersionSchema,
  type ConnectionTypeId,
  type ConnectionTypeSourceDocument,
  type Fingerprint,
  type SemanticVersion,
} from "@vortex/contracts";
import { compare } from "semver";
import { z } from "zod";
import { compareCanonicalStrings, fingerprintCanonicalValue } from "./canonical-json";
import { compileDefinitionSet } from "./validation";
import type {
  DefinitionPublicationCatalogue,
  ResolvableConnectionTypeRelease,
  ResolvablePlatformThemeRelease,
} from "./definition-publication";

export type PlatformConnectionTypeReleaseDefinition = Readonly<{
  source: ConnectionTypeSourceDocument;
  rootId: ConnectionTypeId;
  releaseVersion: SemanticVersion;
}>;

export type PlatformThemeReleaseDefinition = Readonly<{
  catalogueThemeId: string;
  releaseVersion: SemanticVersion;
  contentFingerprint: Fingerprint;
}>;

export type ImmutableDefinitionPublicationCatalogueDefinition = Readonly<{
  connectionTypeReleases: readonly PlatformConnectionTypeReleaseDefinition[];
  platformThemeReleases: readonly PlatformThemeReleaseDefinition[];
}>;

const connectionTypeReleaseDefinitionSchema = z
  .object({
    source: connectionTypeSourceDocumentSchema,
    rootId: connectionTypeIdSchema,
    releaseVersion: stableDefinitionReleaseVersionSchema,
  })
  .strict();

const platformThemeReleaseDefinitionSchema = z
  .object({
    catalogueThemeId: platformIdSchema,
    releaseVersion: stableDefinitionReleaseVersionSchema,
    contentFingerprint: fingerprintSchema,
  })
  .strict();

const catalogueDefinitionSchema = z
  .object({
    connectionTypeReleases: z.array(connectionTypeReleaseDefinitionSchema).max(10_000),
    platformThemeReleases: z.array(platformThemeReleaseDefinitionSchema).max(10_000),
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

const ensureUniquePlatformReleases = (
  connectionTypes: readonly PlatformConnectionTypeReleaseDefinition[],
  themes: readonly PlatformThemeReleaseDefinition[],
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

  const themeVersions = new Set<string>();
  for (const release of themes) {
    const versionKey = `${release.catalogueThemeId}:${release.releaseVersion}`;
    if (themeVersions.has(versionKey)) duplicate();
    themeVersions.add(versionKey);
  }
};

const compileConnectionTypeRelease = (
  definition: PlatformConnectionTypeReleaseDefinition,
  catalogueFingerprint: Fingerprint,
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
  return deepFreeze({
    key: definition.source.key,
    rootId: definition.rootId,
    releaseVersion: definition.releaseVersion,
    contentFingerprint: connectionOutput.artifact.contentFingerprint,
    catalogueFingerprint,
    compilationOutput: connectionOutput,
  });
};

/**
 * Creates the read-only publication catalogue used until durable platform-catalogue storage exists.
 * Connection releases are compiled from the governed source contract; theme content remains owned by
 * the platform release and is represented by its exact immutable content fingerprint.
 */
export const createImmutableDefinitionPublicationCatalogue = (
  input: ImmutableDefinitionPublicationCatalogueDefinition,
): DefinitionPublicationCatalogue => {
  const parsed = catalogueDefinitionSchema.safeParse(input);
  const definition = parsed.success ? parsed.data : duplicate();
  ensureUniquePlatformReleases(definition.connectionTypeReleases, definition.platformThemeReleases);

  const catalogueFingerprint = fingerprintCanonicalValue({
    connectionTypeReleases: definition.connectionTypeReleases
      .map((release) => ({
        key: release.source.key,
        rootId: release.rootId,
        releaseVersion: release.releaseVersion,
        sourceFingerprint: fingerprintCanonicalValue(release.source),
      }))
      .sort((left, right) =>
        compareCanonicalStrings(
          `${left.key}:${left.releaseVersion}`,
          `${right.key}:${right.releaseVersion}`,
        ),
      ),
    platformThemeReleases: [...definition.platformThemeReleases].sort((left, right) =>
      compareCanonicalStrings(
        `${left.catalogueThemeId}:${left.releaseVersion}`,
        `${right.catalogueThemeId}:${right.releaseVersion}`,
      ),
    ),
  });
  const connectionTypes = definition.connectionTypeReleases
    .map((release) => compileConnectionTypeRelease(release, catalogueFingerprint))
    .sort((left, right) =>
      left.key === right.key
        ? compare(left.releaseVersion, right.releaseVersion)
        : compareCanonicalStrings(left.key, right.key),
    );
  const themes: readonly ResolvablePlatformThemeRelease[] = definition.platformThemeReleases.map(
    (release) => deepFreeze({ ...release, catalogueFingerprint }),
  );
  const connectionsByKey = new Map<string, readonly ResolvableConnectionTypeRelease[]>();
  for (const release of connectionTypes)
    connectionsByKey.set(release.key, [...(connectionsByKey.get(release.key) ?? []), release]);
  for (const [key, releases] of connectionsByKey) connectionsByKey.set(key, deepFreeze(releases));
  const connectionsByIdentity = new Map(
    connectionTypes.map((release) => [`${release.rootId}:${release.releaseVersion}`, release]),
  );
  const themesByIdentity = new Map(
    themes.map((release) => [`${release.catalogueThemeId}:${release.releaseVersion}`, release]),
  );

  return Object.freeze({
    listConnectionTypeReleases: async (key: string) => connectionsByKey.get(key) ?? [],
    readConnectionTypeRelease: async (rootId: ConnectionTypeId, releaseVersion: string) =>
      connectionsByIdentity.get(`${rootId}:${releaseVersion}`),
    readPlatformThemeRelease: async (catalogueThemeId: string, releaseVersion: string) =>
      themesByIdentity.get(`${catalogueThemeId}:${releaseVersion}`),
  });
};
