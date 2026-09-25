import {
  assertModuleContractPair,
  selectApplicationContractPair,
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

const exactApplicationFlowTargetsMatch = (
  output: Extract<CustomerDefinitionOutput, { kind: "application" }>,
  manifest: readonly ExactDefinitionDependency[],
): boolean => {
  const expectedBySubject = new Map<string, ExactDefinitionDependency>();
  let conflictingExpected = false;
  const add = (entry: ExactDefinitionDependency): void => {
    const subject = flowManifestSubject(entry);
    const existing = expectedBySubject.get(subject);
    if (existing !== undefined && !sameCanonicalJson(existing, entry)) {
      conflictingExpected = true;
      return;
    }
    expectedBySubject.set(subject, entry);
  };
  const applicationRootId = output.canonical.envelope.rootId;
  const applicationEvidenceMatches = (
    rootId: unknown,
    releaseVersion: unknown,
    resolutionFingerprint: unknown,
  ): boolean =>
    String(rootId) === String(applicationRootId) &&
    releaseVersion === output.artifact.exactVersion &&
    resolutionFingerprint === output.resolutionFingerprint;
  const moduleEvidenceMatches = (
    rootId: unknown,
    releaseVersion: unknown,
    resolutionFingerprint: unknown,
  ): boolean =>
    manifest.some(
      (entry) =>
        entry.kind === "module" &&
        String(entry.rootId) === String(rootId) &&
        entry.releaseVersion === releaseVersion &&
        entry.resolutionFingerprint === resolutionFingerprint,
    );
  for (const flow of output.canonical.content.flows) {
    if (
      !applicationEvidenceMatches(
        applicationRootId,
        flow.releaseVersion,
        flow.resolutionFingerprint,
      )
    )
      return false;
    add({
      kind: "application_flow",
      applicationRootId,
      flowId: flow.flowId,
      releaseVersion: flow.releaseVersion,
      contentFingerprint: flow.contentFingerprint,
      resolutionFingerprint: flow.resolutionFingerprint,
    });
    for (const node of flow.nodes) {
      add({
        kind: "application_flow_node",
        applicationRootId,
        flowId: flow.flowId,
        nodeId: node.nodeId,
        releaseVersion: flow.releaseVersion,
        contentFingerprint: fingerprintCanonicalValue({ kind: "flow_node", node }),
        resolutionFingerprint: flow.resolutionFingerprint,
      });
      const target = (node as unknown as { target?: Record<string, unknown> }).target;
      if (target === undefined) continue;
      const common = {
        releaseVersion: String(target.releaseVersion),
        contentFingerprint: String(target.contentFingerprint),
        resolutionFingerprint: String(target.resolutionFingerprint),
      };
      switch (target.kind) {
        case "application_query":
          if (
            !applicationEvidenceMatches(
              target.applicationRootId,
              target.releaseVersion,
              target.resolutionFingerprint,
            )
          )
            return false;
          add({ kind: "application_query", applicationRootId, queryId: String(target.queryId), ...common });
          break;
        case "query":
          if (
            !moduleEvidenceMatches(
              target.moduleRootId,
              target.moduleReleaseVersion,
              target.resolutionFingerprint,
            )
          )
            return false;
          add({
            kind: "module_query",
            moduleRootId: String(target.moduleRootId),
            queryId: String(target.queryId),
            declaredRequirement: target.declaredRequirement as never,
            ...common,
            releaseVersion: String(target.moduleReleaseVersion),
          });
          break;
        case "protected_operation":
          if (
            target.operation === null ||
            typeof target.operation !== "object" ||
            Array.isArray(target.operation)
          )
            return false;
          {
            const owner = (target.operation as { owner?: Record<string, unknown> }).owner;
            if (owner === undefined) return false;
            if (
              owner.kind === "application" &&
              !applicationEvidenceMatches(
                owner.applicationRootId,
                target.releaseVersion,
                target.resolutionFingerprint,
              )
            )
              return false;
            if (
              owner.kind === "module" &&
              !moduleEvidenceMatches(
                owner.moduleRootId,
                target.releaseVersion,
                target.resolutionFingerprint,
              )
            )
              return false;
            if (owner.kind === "platform_service" && target.catalogueFingerprint === undefined)
              return false;
          }
          add({
            kind: "protected_operation",
            operation: target.operation as never,
            ...common,
            ...(target.catalogueFingerprint === undefined
              ? {}
              : { catalogueFingerprint: String(target.catalogueFingerprint) }),
          });
          break;
        case "form_continuation":
          if (
            !applicationEvidenceMatches(
              target.applicationRootId,
              target.releaseVersion,
              target.resolutionFingerprint,
            )
          )
            return false;
          add({ kind: "application_form", applicationRootId, formId: String(target.formId), ...common });
          break;
        case "durable_workflow_start":
          if (
            !applicationEvidenceMatches(
              target.applicationRootId,
              target.releaseVersion,
              target.resolutionFingerprint,
            )
          )
            return false;
          add({ kind: "application_workflow", applicationRootId, workflowId: String(target.workflowId), ...common });
          break;
        case "application_action":
          if (
            !applicationEvidenceMatches(
              target.applicationRootId,
              target.releaseVersion,
              target.resolutionFingerprint,
            )
          )
            return false;
          add({ kind: "application_action", applicationRootId, actionId: String(target.actionId), ...common });
          break;
        case "record_save":
          // A generic record save is pinned by its owning Module binding's release; it adds no
          // separate entry, but it must belong to this Application and match that Module evidence.
          if (
            String(target.applicationRootId) !== String(applicationRootId) ||
            !moduleEvidenceMatches(
              target.moduleRootId,
              target.releaseVersion,
              target.resolutionFingerprint,
            )
          )
            return false;
          break;
      }
    }
  }
  for (const binding of output.canonical.content.flowBindings) {
    const flow = output.canonical.content.flows.find(
      (candidate) => candidate.flowId === binding.flow.flowId,
    );
    if (
      flow === undefined ||
      !applicationEvidenceMatches(
        binding.flow.applicationRootId,
        binding.flow.releaseVersion,
        binding.flow.resolutionFingerprint,
      ) ||
      binding.flow.contentFingerprint !== flow.contentFingerprint
    )
      return false;
    add({
      kind: "application_flow",
      applicationRootId,
      flowId: binding.flow.flowId,
      releaseVersion: binding.flow.releaseVersion,
      contentFingerprint: binding.flow.contentFingerprint,
      resolutionFingerprint: binding.flow.resolutionFingerprint,
    });
  }
  const actual = manifest.filter((entry) => flowManifestSubject(entry) !== "");
  const actualBySubject = new Map(actual.map((entry) => [flowManifestSubject(entry), entry]));
  if (conflictingExpected || actualBySubject.size !== actual.length) return false;
  if (expectedBySubject.size !== actualBySubject.size) return false;
  return [...expectedBySubject].every(
    ([subject, entry]) => sameCanonicalJson(entry, actualBySubject.get(subject)),
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
      ...blockDependencies.map((entry) => `platform_block:${entry.blockId}`),
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
