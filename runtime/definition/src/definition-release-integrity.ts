import type {
  DefinitionCompilationOutput,
  DefinitionResolutionSnapshot,
  Fingerprint,
  OrganizationId,
  SemanticVersion,
} from "@vortex/contracts";
import { canonicalJson, fingerprintCanonicalValue } from "./canonical-json";

type CustomerDefinitionOutput = Exclude<DefinitionCompilationOutput, { kind: "connection_type" }>;

export type StoredCustomerDefinitionReleaseEvidence = Readonly<{
  organizationId: OrganizationId;
  kind: "module" | "application";
  key: string;
  rootId: string;
  releaseVersion: SemanticVersion;
  contentFingerprint: Fingerprint;
  resolutionFingerprint: Fingerprint;
  compilationOutput: CustomerDefinitionOutput;
  resolutionSnapshot: DefinitionResolutionSnapshot;
}>;

export const sameCanonicalJson = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

export const hasAuthenticResolutionFingerprint = (
  snapshot: DefinitionResolutionSnapshot,
): boolean =>
  snapshot.fingerprint ===
  fingerprintCanonicalValue({
    contractVersion: snapshot.contractVersion,
    definitions: snapshot.definitions,
    identities: snapshot.identities,
  });

/**
 * One shared interpretation of the immutable release row used by publication
 * history and consumer reads. Dependency-manifest checks remain caller-specific
 * because publication preparation needs Module definitions while consumers need
 * the complete Module, connection-type and platform-theme manifest.
 */
export const hasAuthenticStoredCustomerDefinitionRelease = (
  release: StoredCustomerDefinitionReleaseEvidence,
): boolean => {
  const { compilationOutput: output, resolutionSnapshot: snapshot } = release;
  const ownResolution = snapshot.definitions.filter(
    (definition) =>
      definition.kind === release.kind &&
      definition.key === release.key &&
      String(definition.rootId) === release.rootId &&
      definition.exactVersion === release.releaseVersion,
  );

  return (
    output.kind === release.kind &&
    output.canonical.envelope.organizationId === release.organizationId &&
    output.canonical.envelope.key === release.key &&
    String(output.canonical.envelope.rootId) === release.rootId &&
    output.artifact.definitionKey === release.key &&
    String(output.artifact.rootId) === release.rootId &&
    output.artifact.exactVersion === release.releaseVersion &&
    output.artifact.contentFingerprint === release.contentFingerprint &&
    output.artifact.resolutionFingerprint === release.resolutionFingerprint &&
    output.resolutionFingerprint === release.resolutionFingerprint &&
    snapshot.fingerprint === release.resolutionFingerprint &&
    hasAuthenticResolutionFingerprint(snapshot) &&
    ownResolution.length === 1 &&
    fingerprintCanonicalValue(output.canonical.content) === release.contentFingerprint
  );
};
