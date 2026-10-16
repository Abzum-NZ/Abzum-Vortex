import { fingerprintCanonicalValue } from "./canonical-json-definition";
import type { ConnectionTypeSourceDocument } from "../schema";

/**
 * The one derivation of each platform catalogue release content hash. The publication catalogue
 * uses the same hash that the server-owned catalogue materialises when it loads a release.
 * This module is plain, erasable TypeScript with no server-only import.
 */
type CatalogueReleaseContentHash = Readonly<{
  contentFingerprint: `sha256:${string}`;
}>;

/** A provider-neutral connection release hashes the same canonical content the compiler emits. */
export const platformConnectionTypeReleaseContentHash = (definition: {
  source: ConnectionTypeSourceDocument;
  rootId: string;
  releaseVersion: string;
}): CatalogueReleaseContentHash => {
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
  return { contentFingerprint: fingerprintCanonicalValue(canonical) };
};

/** A block release's content hash is its metadata hash. */
export const platformBlockReleaseContentHash = (definition: {
  blockId: string;
  key: string;
  releaseVersion: string;
  name: unknown;
  icon: unknown;
  paletteGroup: unknown;
  rendererKey: unknown;
  properties: unknown;
  derivedProperties?: unknown;
  slots: unknown;
  capabilities: unknown;
  supportedEvents: unknown;
  supportedStateOperations: unknown;
  customComponent?: unknown;
}): CatalogueReleaseContentHash => {
  const contentFingerprint = fingerprintCanonicalValue({
    name: definition.name,
    icon: definition.icon,
    paletteGroup: definition.paletteGroup,
    rendererKey: definition.rendererKey,
    properties: definition.properties,
    // The settings the compiler derives are part of what a placement of the release carries.
    ...(definition.derivedProperties === undefined
      ? {}
      : { derivedProperties: definition.derivedProperties }),
    slots: definition.slots,
    capabilities: definition.capabilities,
    supportedEvents: definition.supportedEvents,
    supportedStateOperations: definition.supportedStateOperations,
    // A custom component release's bundle manifest and declared events are part of its content,
    // so a bundle digest change updates its content hash.
    ...(definition.customComponent === undefined
      ? {}
      : { customComponent: definition.customComponent }),
  });
  return { contentFingerprint };
};

/** A theme release's content is its token map. */
export const platformThemeReleaseContentHash = (definition: {
  catalogueThemeId: string;
  releaseVersion: string;
  tokens: unknown;
}): CatalogueReleaseContentHash => {
  return { contentFingerprint: fingerprintCanonicalValue(definition.tokens) };
};

/** A platform-service operation release's content is its typed descriptor. */
export const platformServiceOperationReleaseContentHash = (
  descriptor: unknown,
): CatalogueReleaseContentHash => {
  return { contentFingerprint: fingerprintCanonicalValue(descriptor) };
};
