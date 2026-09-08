import {
  selectApplicationContractPair,
  selectModuleContractPair,
  type ApplicationCompilationOutputV2,
  type DefinitionCompilationOutput,
  type DefinitionResolutionSnapshot,
  type DefinitionResolutionSnapshotV2,
  type DefinitionResolutionSnapshotV3,
  type ExactDefinitionDependency,
  type Fingerprint,
  type OrganizationId,
  type SemanticVersion,
} from "@vortex/contracts";
import { canonicalJson, fingerprintCanonicalValue } from "./canonical-json";

type CustomerDefinitionOutput = Exclude<DefinitionCompilationOutput, { kind: "connection_type" }>;
type CustomerDefinitionResolution =
  DefinitionResolutionSnapshot | DefinitionResolutionSnapshotV2 | DefinitionResolutionSnapshotV3;

export type StoredCustomerDefinitionReleaseEvidence = Readonly<{
  organizationId: OrganizationId;
  kind: "module" | "application";
  key: string;
  rootId: string;
  releaseVersion: SemanticVersion;
  sourceContractVersion: SemanticVersion;
  validationContractVersion: SemanticVersion;
  contentFingerprint: Fingerprint;
  resolutionFingerprint: Fingerprint;
  compilationOutput: CustomerDefinitionOutput;
  resolutionSnapshot: CustomerDefinitionResolution;
}>;

export const sameCanonicalJson = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

export const hasAuthenticResolutionFingerprint = (
  snapshot: CustomerDefinitionResolution,
): boolean =>
  snapshot.fingerprint ===
  fingerprintCanonicalValue({
    contractVersion: snapshot.contractVersion,
    definitions: snapshot.definitions,
    identities: snapshot.identities,
  });

const manifestSubject = (dependency: ExactDefinitionDependency): string =>
  dependency.kind === "platform_theme"
    ? `${dependency.kind}:${dependency.catalogueThemeId}`
    : dependency.kind === "platform_block"
      ? `${dependency.kind}:${dependency.blockId}`
      : `${dependency.kind}:${dependency.key}`;

const sameStringSet = (left: readonly string[], right: readonly string[]): boolean => {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    left.length === right.length &&
    leftSet.size === left.length &&
    rightSet.size === right.length &&
    left.every((subject) => rightSet.has(subject))
  );
};

const exactApplicationDependenciesMatch = (
  output: Extract<CustomerDefinitionOutput, { kind: "application" }>,
  manifest: readonly ExactDefinitionDependency[],
): boolean => {
  const moduleEntries = manifest.filter(
    (entry): entry is Extract<ExactDefinitionDependency, { kind: "module" }> =>
      entry.kind === "module",
  );
  const connectionEntries = manifest.filter(
    (entry): entry is Extract<ExactDefinitionDependency, { kind: "connection_type" }> =>
      entry.kind === "connection_type",
  );
  const moduleSubjects = output.canonical.content.moduleBindings.map((binding) =>
    moduleEntries.find(
      (entry) =>
        entry.rootId === binding.moduleRootId && entry.releaseVersion === binding.resolvedVersion,
    ),
  );
  const connectionSubjects = output.canonical.content.connectionBindings.map((binding) =>
    connectionEntries.find(
      (entry) =>
        entry.rootId === binding.connectionTypeId &&
        entry.releaseVersion === binding.resolvedVersion,
    ),
  );
  if (
    moduleSubjects.some((entry) => entry === undefined) ||
    connectionSubjects.some((entry) => entry === undefined)
  )
    return false;

  if ("validationContractVersion" in output) {
    const v2 = output as ApplicationCompilationOutputV2;
    const blockEntries = manifest.filter(
      (entry): entry is Extract<ExactDefinitionDependency, { kind: "platform_block" }> =>
        entry.kind === "platform_block",
    );
    const blockDependencies = v2.canonical.content.platformBlockDependencies;
    if (
      blockEntries.length !== blockDependencies.length ||
      blockDependencies.some(
        (dependency) =>
          !blockEntries.some(
            (entry) =>
              entry.blockId === dependency.blockId &&
              entry.releaseVersion === dependency.releaseVersion &&
              entry.contentFingerprint === dependency.contentFingerprint &&
              entry.catalogueFingerprint === dependency.catalogueFingerprint,
          ),
      )
    )
      return false;
    const base = v2.canonical.content.theme.base;
    const theme = manifest.filter((entry) => entry.kind === "platform_theme");
    if (
      theme.length !== 1 ||
      theme[0]!.catalogueThemeId !== base.catalogueThemeId ||
      theme[0]!.releaseVersion !== base.releaseVersion ||
      theme[0]!.contentFingerprint !== base.contentFingerprint ||
      theme[0]!.catalogueFingerprint !== base.catalogueFingerprint
    )
      return false;
    return sameStringSet(
      [
        ...moduleSubjects.map((entry) => `module:${entry!.key}`),
        ...connectionSubjects.map((entry) => `connection_type:${entry!.key}`),
        ...blockDependencies.map((entry) => `platform_block:${entry.blockId}`),
        `platform_theme:${base.catalogueThemeId}`,
      ],
      manifest.map(manifestSubject),
    );
  }

  const theme = output.canonical.content.theme;
  const themeEntries = manifest.filter((entry) => entry.kind === "platform_theme");
  if (
    theme.mode === "platform" &&
    (themeEntries.length !== 1 ||
      themeEntries[0]!.catalogueThemeId !== theme.catalogueThemeId ||
      themeEntries[0]!.releaseVersion !== theme.version)
  )
    return false;
  if (theme.mode !== "platform" && themeEntries.length !== 0) return false;
  return sameStringSet(
    [
      ...moduleSubjects.map((entry) => `module:${entry!.key}`),
      ...connectionSubjects.map((entry) => `connection_type:${entry!.key}`),
      ...(theme.mode === "platform" ? [`platform_theme:${theme.catalogueThemeId}`] : []),
    ],
    manifest.map(manifestSubject),
  );
};

export const releaseManifestMatchesCanonicalContent = (
  output: CustomerDefinitionOutput,
  manifest: readonly ExactDefinitionDependency[],
): boolean => {
  if (output.kind === "application") return exactApplicationDependenciesMatch(output, manifest);
  const dependencies = output.canonical.content.dependencies;
  const modules = manifest.filter(
    (entry): entry is Extract<ExactDefinitionDependency, { kind: "module" }> =>
      entry.kind === "module",
  );
  return (
    modules.length === manifest.length &&
    modules.length === dependencies.length &&
    dependencies.every((dependency) =>
      modules.some(
        (entry) =>
          entry.key === dependency.moduleKey &&
          entry.rootId === dependency.moduleRootId &&
          entry.releaseVersion === dependency.resolvedVersion,
      ),
    ) &&
    sameStringSet(
      dependencies.map((dependency) => `module:${dependency.moduleKey}`),
      manifest.map(manifestSubject),
    )
  );
};

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
  if (release.kind === "application") {
    let pair: "v1" | "v2";
    try {
      pair = selectApplicationContractPair(
        release.sourceContractVersion,
        release.validationContractVersion,
      ).schema;
    } catch {
      return false;
    }
    const expectedVersion = pair === "v2" ? "2.0.0" : "1.0.0";
    const outputVersion =
      "validationContractVersion" in output ? output.validationContractVersion : "1.0.0";
    if (
      outputVersion !== expectedVersion ||
      snapshot.contractVersion !== expectedVersion ||
      outputVersion !== release.validationContractVersion
    )
      return false;
  } else {
    let pair: "v1" | "v2" | "v3";
    try {
      pair = selectModuleContractPair(
        release.sourceContractVersion,
        release.validationContractVersion,
      ).schema;
    } catch {
      return false;
    }
    const expectedVersion = pair === "v3" ? "3.0.0" : pair === "v2" ? "2.0.0" : "1.0.0";
    const outputVersion =
      "validationContractVersion" in output ? output.validationContractVersion : "1.0.0";
    if (
      outputVersion !== expectedVersion ||
      snapshot.contractVersion !== expectedVersion ||
      outputVersion !== release.validationContractVersion
    )
      return false;
  }
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
