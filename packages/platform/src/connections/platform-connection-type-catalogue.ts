import { connectionTypeSourceDocumentSchema } from "./connection-source-contracts";
import { platformConnectionTypeReleaseContentHash } from "../definition/catalogue-release-content-hashes";
import source from "../catalogue/catalogue/platform-connection-type-catalogue.source.json";
import type { ConnectionTypeSourceDocument } from "../definition/definition-source";
import {
  connectionTypeIdSchema,
  semanticVersionSchema,
  stableDefinitionReleaseVersionSchema,
  type ConnectionTypeId,
  type SemanticVersion,
} from "../catalogue/identifiers";

const deepFreeze = <Value>(value: Value): Value => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
};

export type PlatformConnectionTypeCatalogueRelease = Readonly<{
  source: ConnectionTypeSourceDocument;
  rootId: ConnectionTypeId;
  releaseVersion: SemanticVersion;
  contentFingerprint: string;
}>;

const release = (definition: {
  source: unknown;
  rootId: string;
  releaseVersion: string;
}): PlatformConnectionTypeCatalogueRelease => {
  const sourceDocument = connectionTypeSourceDocumentSchema.parse(definition.source);
  return deepFreeze({
    source: sourceDocument,
    rootId: connectionTypeIdSchema.parse(definition.rootId),
    releaseVersion: semanticVersionSchema.parse(definition.releaseVersion),
    ...platformConnectionTypeReleaseContentHash({
      source: sourceDocument,
      rootId: definition.rootId,
      releaseVersion: definition.releaseVersion,
    }),
  });
};

/** The immutable, platform-owned connection-type releases available to every environment. */
export const PLATFORM_CONNECTION_TYPE_RELEASES: readonly PlatformConnectionTypeCatalogueRelease[] =
  deepFreeze(Object.values(source).map(release));

/** The latest stable release for each connection type, keyed by its stable source key. */
export const CURRENT_CONNECTION_TYPE_RELEASES = deepFreeze(
  PLATFORM_CONNECTION_TYPE_RELEASES.filter(
    (release) => stableDefinitionReleaseVersionSchema.safeParse(release.releaseVersion).success,
  )
    .sort((a, b) => {
      const left = a.releaseVersion.split(".").map(BigInt);
      const right = b.releaseVersion.split(".").map(BigInt);
      for (let index = 0; index < 3; index++) {
        if (left[index]! !== right[index]!) return left[index]! > right[index]! ? -1 : 1;
      }
      return 0;
    })
    .filter(
      (release, index, all) =>
        all.findIndex((entry) => entry.source.key === release.source.key) === index,
    ),
);
