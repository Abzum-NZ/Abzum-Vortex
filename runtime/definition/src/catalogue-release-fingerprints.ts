import { fingerprintCanonicalValue } from "./canonical-json";

/**
 * The one derivation of every platform catalogue release fingerprint. The publication catalogue
 * uses it to materialise and verify releases, and tooling/generate-catalogue-fingerprints.mjs uses
 * it to write the fingerprints the contracts catalogues carry, so a release fingerprint has one
 * definition. This module is plain, erasable TypeScript with no server-only import so the
 * generator can load it directly.
 */
export type CatalogueReleaseFingerprints = Readonly<{
  contentFingerprint: `sha256:${string}`;
  catalogueFingerprint: `sha256:${string}`;
}>;

/** A block release's content is its own metadata; its catalogue fingerprint binds identity to it. */
export const platformBlockReleaseFingerprints = (definition: {
  blockId: string;
  key: string;
  releaseVersion: string;
  name: unknown;
  icon: unknown;
  paletteGroup: unknown;
  rendererKey: unknown;
  properties: unknown;
  slots: unknown;
  capabilities: unknown;
  supportedEvents: unknown;
  supportedStateOperations: unknown;
}): CatalogueReleaseFingerprints => {
  const contentFingerprint = fingerprintCanonicalValue({
    name: definition.name,
    icon: definition.icon,
    paletteGroup: definition.paletteGroup,
    rendererKey: definition.rendererKey,
    properties: definition.properties,
    slots: definition.slots,
    capabilities: definition.capabilities,
    supportedEvents: definition.supportedEvents,
    supportedStateOperations: definition.supportedStateOperations,
  });
  return {
    contentFingerprint,
    catalogueFingerprint: fingerprintCanonicalValue({
      kind: "platform_block",
      blockId: definition.blockId,
      key: definition.key,
      releaseVersion: definition.releaseVersion,
      contentFingerprint,
    }),
  };
};

/** A theme release's content is its token map. */
export const platformThemeReleaseFingerprints = (definition: {
  catalogueThemeId: string;
  releaseVersion: string;
  tokens: unknown;
}): CatalogueReleaseFingerprints => {
  const contentFingerprint = fingerprintCanonicalValue(definition.tokens);
  return {
    contentFingerprint,
    catalogueFingerprint: fingerprintCanonicalValue({
      kind: "platform_theme",
      catalogueThemeId: definition.catalogueThemeId,
      releaseVersion: definition.releaseVersion,
      contentFingerprint,
    }),
  };
};

/** A platform-service operation release's content is its typed descriptor. */
export const platformServiceOperationReleaseFingerprints = (
  release: { serviceId: string; operationId: string; releaseVersion: string },
  descriptor: unknown,
): CatalogueReleaseFingerprints => {
  const contentFingerprint = fingerprintCanonicalValue(descriptor);
  return {
    contentFingerprint,
    catalogueFingerprint: fingerprintCanonicalValue({
      kind: "platform_service_operation",
      serviceId: release.serviceId,
      operationId: release.operationId,
      releaseVersion: release.releaseVersion,
      contentFingerprint,
    }),
  };
};
