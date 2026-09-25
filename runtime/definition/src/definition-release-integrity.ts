import {
  assertModuleContractPair,
  selectApplicationContractPair,
  type DefinitionCompilationOutput,
  type DefinitionResolutionSnapshot,
  type DefinitionResolutionSnapshotV2,
  type DefinitionResolutionSnapshotV3,
  type ExactDefinitionDependency,
  type FlowDefinition,
  type Fingerprint,
  type OrganizationId,
  type SemanticVersion,
} from "@vortex/contracts";
import { canonicalJson, fingerprintCanonicalValue } from "./canonical-json";
import { platformOperationsCalledBy } from "./flow-operation-calls";

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
      ? `${dependency.kind}:${dependency.blockId}@${dependency.releaseVersion}`
      : dependency.kind === "application_flow"
          ? `${dependency.kind}:${dependency.applicationRootId}:${dependency.flowId}`
          : dependency.kind === "application_flow_node"
            ? `${dependency.kind}:${dependency.applicationRootId}:${dependency.flowId}:${dependency.nodeId}`
            : dependency.kind === "application_query"
              ? `${dependency.kind}:${dependency.applicationRootId}:${dependency.queryId}`
              : dependency.kind === "module_query"
                ? `${dependency.kind}:${dependency.moduleRootId}:${dependency.queryId}`
                : dependency.kind === "application_form"
                  ? `${dependency.kind}:${dependency.applicationRootId}:${dependency.formId}`
                    : dependency.kind === "application_workflow"
                      ? `${dependency.kind}:${dependency.applicationRootId}:${dependency.workflowId}`
                      : dependency.kind === "application_action"
                        ? `${dependency.kind}:${dependency.applicationRootId}:${dependency.actionId}`
                    : dependency.kind === "protected_operation"
                      ? `${dependency.kind}:${dependency.operation.owner.kind}:${
                          dependency.operation.owner.kind === "application"
                            ? dependency.operation.owner.applicationRootId
                            : dependency.operation.owner.kind === "module"
                              ? dependency.operation.owner.moduleRootId
                              : dependency.operation.owner.serviceId
                        }:${dependency.operation.operationId}`
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

const flowManifestSubject = (dependency: ExactDefinitionDependency): string => {
  switch (dependency.kind) {
    case "application_flow":
      return `${dependency.kind}:${dependency.applicationRootId}:${dependency.flowId}`;
    case "application_flow_node":
      return `${dependency.kind}:${dependency.applicationRootId}:${dependency.flowId}:${dependency.nodeId}`;
    case "application_query":
      return `${dependency.kind}:${dependency.applicationRootId}:${dependency.queryId}`;
    case "module_query":
      return `${dependency.kind}:${dependency.moduleRootId}:${dependency.queryId}`;
    case "application_form":
      return `${dependency.kind}:${dependency.applicationRootId}:${dependency.formId}`;
    case "application_workflow":
      return `${dependency.kind}:${dependency.applicationRootId}:${dependency.workflowId}`;
    case "application_action":
      return `${dependency.kind}:${dependency.applicationRootId}:${dependency.actionId}`;
    case "protected_operation":
      return `${dependency.kind}:${dependency.operation.owner.kind}:${
        dependency.operation.owner.kind === "application"
          ? dependency.operation.owner.applicationRootId
          : dependency.operation.owner.kind === "module"
            ? dependency.operation.owner.moduleRootId
            : dependency.operation.owner.serviceId
      }:${dependency.operation.operationId}`;
    default:
      return "";
  }
};

/**
 * The Application's flows and bindings are contained in its own release, so the only flow targets
 * its manifest pins are the platform-service operations its Call protected operation tasks name.
 * The manifest must hold exactly one entry for each, resolved with this release's own resolution.
 * The operation's release version and fingerprints are the ones publication pinned; they are read
 * from the manifest, never from today's catalogue, so a later catalogue release cannot make an
 * earlier Application release fail its integrity check.
 */
const exactApplicationFlowTargetsMatch = (
  output: Extract<CustomerDefinitionOutput, { kind: "application" }>,
  manifest: readonly ExactDefinitionDependency[],
): boolean => {
  const expectedSubjects = new Set(
    platformOperationsCalledBy(output.canonical.content.flows as unknown as FlowDefinition[]).map(
      (operation) =>
        flowManifestSubject({
          kind: "protected_operation",
          operation: {
            owner: { kind: "platform_service", serviceId: operation.release.serviceId },
            operationId: operation.release.operationId,
          },
          releaseVersion: operation.release.releaseVersion,
          contentFingerprint: operation.release.contentFingerprint,
          resolutionFingerprint: output.resolutionFingerprint,
          catalogueFingerprint: operation.release.catalogueFingerprint,
        }),
    ),
  );
  const actual = manifest.filter((entry) => flowManifestSubject(entry) !== "");
  const actualSubjects = new Set(actual.map(flowManifestSubject));
  if (actualSubjects.size !== actual.length || actualSubjects.size !== expectedSubjects.size)
    return false;
  return actual.every(
    (entry) =>
      entry.kind === "protected_operation" &&
      entry.operation.owner.kind === "platform_service" &&
      entry.resolutionFingerprint === output.resolutionFingerprint &&
      entry.catalogueFingerprint !== undefined &&
      expectedSubjects.has(flowManifestSubject(entry)),
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

  const blockEntries = manifest.filter(
    (entry): entry is Extract<ExactDefinitionDependency, { kind: "platform_block" }> =>
      entry.kind === "platform_block",
  );
  const blockDependencies = output.canonical.content.platformBlockDependencies;
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
  const base = output.canonical.content.theme.base;
  const theme = manifest.filter((entry) => entry.kind === "platform_theme");
  if (
    theme.length !== 1 ||
    theme[0]!.catalogueThemeId !== base.catalogueThemeId ||
    theme[0]!.releaseVersion !== base.releaseVersion ||
    theme[0]!.contentFingerprint !== base.contentFingerprint ||
    theme[0]!.catalogueFingerprint !== base.catalogueFingerprint
  )
    return false;
  // The compiler places authoritative target evidence on each target, so the stored flow-target
  // entries must equal the targets derived from the canonical content one-for-one, and the
  // module, connection, block and theme subjects must be exactly the canonical bindings.
  return (
    exactApplicationFlowTargetsMatch(output, manifest) &&
    sameStringSet(
    [
      ...moduleSubjects.map((entry) => `module:${entry!.key}`),
      ...connectionSubjects.map((entry) => `connection_type:${entry!.key}`),
      ...blockDependencies.map(
        (entry) => `platform_block:${entry.blockId}@${entry.releaseVersion}`,
      ),
      `platform_theme:${base.catalogueThemeId}`,
    ],
    manifest
      .filter((entry) =>
        ["module", "connection_type", "platform_block", "platform_theme"].includes(
          entry.kind,
        ),
      )
      .map(manifestSubject),
    )
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
  const expectedVersion = release.kind === "application" ? "2.0.0" : "3.0.0";
  try {
    if (release.kind === "application")
      selectApplicationContractPair(
        release.sourceContractVersion,
        release.validationContractVersion,
      );
    else assertModuleContractPair(release.sourceContractVersion, release.validationContractVersion);
  } catch {
    return false;
  }
  if (
    output.validationContractVersion !== expectedVersion ||
    snapshot.contractVersion !== expectedVersion ||
    output.validationContractVersion !== release.validationContractVersion
  )
    return false;
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
