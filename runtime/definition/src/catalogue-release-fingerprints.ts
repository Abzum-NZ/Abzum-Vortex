import { fingerprintCanonicalValue } from "./canonical-json";
import type { ConnectionTypeSourceDocument } from "@vortex/contracts";

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

/** A provider-neutral connection release hashes the same canonical content the compiler emits. */
export const platformConnectionTypeReleaseFingerprints = (definition: {
  source: ConnectionTypeSourceDocument;
  rootId: string;
  releaseVersion: string;
}): CatalogueReleaseFingerprints => {
  const source = definition.source;
  const body = source.body;
  const authentication = body.authentication;
  const canonical = {
    connectionTypeId: definition.rootId,
    key: source.key,
    version: definition.releaseVersion,
    name: body.name,
    purpose: body.purpose,
    provider: body.provider,
    authentication:
      authentication.kind === "oauth2"
        ? {
            kind: "oauth2",
            secretFieldKeys: authentication.secret_fields,
            scopes: authentication.scopes,
          }
        : authentication.kind === "signed_secret"
          ? {
              kind: "signed_secret",
              secretFieldKeys: authentication.secret_fields,
              algorithm: authentication.algorithm,
            }
          : {
              kind: "api_key",
              secretFieldKeys: authentication.secret_fields,
              placement: authentication.placement,
            },
    allowedHosts: body.allowed_hosts,
    allowRedirects: body.allow_redirects,
    shapes: body.shapes.map((shape) => ({ key: shape.key, fields: shape.fields })),
    operations: body.operations.map((operation) => ({
      key: operation.key,
      method: operation.method,
      pathTemplate: operation.path,
      inputShapeKey: operation.input,
      outputShapeKey: operation.output,
      timeoutSeconds: operation.timeout_seconds,
      maximumAttempts: operation.max_attempts,
      maximumResponseBytes: operation.maximum_response_bytes,
    })),
    incomingMessages: body.incoming_messages.map((message) => ({
      key: message.key,
      signature: message.signature,
      replayWindowSeconds: message.replay_window_seconds,
      inputShapeKey: message.input,
      workflowTriggerKey: message.workflow_trigger,
    })),
    ...(body.health_operation ? { healthOperationKey: body.health_operation } : {}),
    ...(body.revocation_operation ? { revocationOperationKey: body.revocation_operation } : {}),
  };
  const contentFingerprint = fingerprintCanonicalValue(canonical);
  return {
    contentFingerprint,
    catalogueFingerprint: fingerprintCanonicalValue({
      kind: "connection_type",
      key: source.key,
      rootId: definition.rootId,
      releaseVersion: definition.releaseVersion,
      sourceFingerprint: fingerprintCanonicalValue(source),
    }),
  };
};

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
  customComponent?: unknown;
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
    // A custom component release's bundle manifest and declared events are part of its content,
    // so any bundle digest change moves its content and catalogue fingerprints. The field is
    // omitted for platform block releases, whose fingerprints stay unchanged.
    ...(definition.customComponent === undefined
      ? {}
      : { customComponent: definition.customComponent }),
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
