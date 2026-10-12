import { connectionTypeSourceDocumentSchema } from "./connection-source-contracts";
import { generatedReleaseFingerprints } from "./catalogue/generated-fingerprints";
import source from "./catalogue/platform-connection-type-catalogue.source.json";
import type { ConnectionTypeSourceDocument } from "./definition-source";
import {
  connectionTypeIdSchema,
  semanticVersionSchema,
  type ConnectionTypeId,
  type SemanticVersion,
} from "./identifiers";

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
  catalogueFingerprint: string;
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
    ...generatedReleaseFingerprints(
      "platformConnectionTypes",
      `${definition.rootId}:${definition.releaseVersion}`,
    ),
  });
};

/** The immutable, platform-owned connection-type releases available to every environment. */
export const PLATFORM_CONNECTION_TYPE_RELEASES: readonly PlatformConnectionTypeCatalogueRelease[] =
  deepFreeze(Object.values(source).map(release));
