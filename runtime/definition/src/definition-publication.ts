import "server-only";

import {
  applicationCompilationRequestV2Schema,
  applicationCompositionCatalogueSnapshotV2Schema,
  assertModuleContractPair,
  definitionCompilationOutputSchema,
  definitionPublicationConfirmationSchema,
  definitionResolutionSnapshotV3Schema,
  moduleCompilationRequestV3Schema,
  prepareDefinitionPublicationCommandSchema,
  prepareDefinitionPublicationResultSchema,
  publishDefinitionCommandSchema,
  publishDefinitionResultSchema,
  savedConditionRevisionAssignmentSchema,
  stableDefinitionReleaseVersionSchema,
  storedDefinitionDraftSchema,
  sourceIdentityKindV2Schema,
  type DefinitionCompilationOutput,
  type DefinitionPublicationConfirmation,
  type DefinitionPublicationHistoryEvidence,
  type DefinitionResolutionSnapshot,
  type DefinitionResolutionSnapshotV2,
  type DefinitionResolutionSnapshotV3,
  type ApplicationCompositionCatalogueSnapshotV2,
  type ApplicationSourceDocumentV2,
  type BlockId,
  type ExactDefinitionDependency,
  type PrepareDefinitionPublicationCommand,
  type PrepareDefinitionPublicationResult,
  type PublishDefinitionCommand,
  type ModuleVersionImpactHistoryEntryV3,
  type PublishDefinitionResult,
  type SavedConditionRevisionAssignment,
  type SessionContext,
  type StoredDefinitionDraft,
  type VersionRequirement,
  type ConnectionTypeId,
  type Fingerprint,
  type ModuleRootId,
  type OrganizationId,
  type PlatformBlockReleaseV2,
  type PlatformId,
  type PlatformThemeReleaseV2,
  type PlatformManagedFlowDependency,
  type PlatformServiceOperationRelease,
  type Revision,
  type SemanticVersion,
} from "@vortex/contracts";
import { compare, satisfies } from "semver";
import type { z } from "zod";
import { compareCanonicalStrings, fingerprintCanonicalValue } from "./canonical-json";
import { createApplicationResolutionSnapshotV2 } from "./application-v2-resolution";
import { compileParsedDefinition } from "./compiler";
import { DefinitionCompilationError } from "./compilation-error";
import { validateDefinitionSet } from "./validation";
import {
  compareDefinitionVersionImpactWithEvidence,
  deriveSavedConditionRevisionsFromHistoryEvidence,
  isVerifiedDefinitionPublicationHistoryEvidence,
} from "./version-impact";
import { DefinitionVersionImpactError } from "./version-impact-error";

type SourceIdentityAssignments = DefinitionResolutionSnapshotV3["identities"];
type ModuleOutput = Extract<DefinitionCompilationOutput, { kind: "module" }>;
type ConnectionOutput = Extract<DefinitionCompilationOutput, { kind: "connection_type" }>;
type DefinitionResolution =
  DefinitionResolutionSnapshot | DefinitionResolutionSnapshotV2 | DefinitionResolutionSnapshotV3;

export type DefinitionPublicationFailureCode =
  | "INVALID_DEFINITION_PUBLICATION_COMMAND"
  | "DEFINITION_DRAFT_STALE_OR_MISSING"
  | "DEFINITION_ORGANIZATION_MISMATCH"
  | "DEFINITION_SOURCE_EVIDENCE_MISMATCH"
  | "DEFINITION_HISTORY_INVALID"
  | "DEFINITION_DEPENDENCY_MISSING"
  | "DEFINITION_DEPENDENCY_PRERELEASE_ONLY"
  | "DEFINITION_DEPENDENCY_INCOMPATIBLE"
  | "DEFINITION_DEPENDENCY_AMBIGUOUS"
  | "DEFINITION_DEPENDENCY_SUBSTITUTED"
  | "DEFINITION_DEPENDENCY_CYCLE"
  | "DEFINITION_COMPILATION_REFUSED"
  | "DEFINITION_VERSION_REFUSED"
  | "DEFINITION_NO_CHANGE"
  | "DEFINITION_CONFIRMATION_MISMATCH"
  | "DEFINITION_PUBLICATION_FAILED";

export class DefinitionPublicationError extends Error {
  readonly code: DefinitionPublicationFailureCode;

  constructor(code: DefinitionPublicationFailureCode) {
    super(code);
    this.name = "DefinitionPublicationError";
    this.code = code;
  }
}

const refuse = (code: DefinitionPublicationFailureCode): never => {
  throw new DefinitionPublicationError(code);
};

/** Read model needed to compile one current draft. Implementations must tenant-scope every method. */
type DefinitionPublicationCandidateCommon = Readonly<{
  draft: StoredDefinitionDraft;
  identities: SourceIdentityAssignments;
}>;

/**
 * Repositories return verified, incrementally folded history evidence before
 * any publication policy consumes it.
 */
export type DefinitionPublicationCandidate = DefinitionPublicationCandidateCommon &
  Readonly<{ historyEvidence: DefinitionPublicationHistoryEvidence }>;

type ValidatedDefinitionPublicationCandidate = DefinitionPublicationCandidateCommon &
  Readonly<{ historyEvidence: DefinitionPublicationHistoryEvidence }>;

/** Immutable organization-owned module release made available to a dependency compilation. */
export type ResolvableModuleRelease = Readonly<{
  organizationId: OrganizationId;
  key: string;
  rootId: ModuleRootId;
  releaseRevision: Revision;
  releaseVersion: SemanticVersion;
  contentFingerprint: Fingerprint;
  resolutionFingerprint: Fingerprint;
  published: ModuleVersionImpactHistoryEntryV3;
  compilationOutput: ModuleOutput;
  resolutionSnapshot: DefinitionResolutionSnapshotV3;
}>;

export type ModuleReleasePageCursor = Readonly<{
  rootId: ModuleRootId;
  anchorReleaseRevision: Revision;
  afterReleaseRevision: Revision;
}>;

export type ResolvableModuleReleasePage = Readonly<{
  rootId: ModuleRootId | null;
  anchorReleaseRevision: Revision | null;
  entries: readonly Readonly<{
    previousReleaseRevision: Revision | null;
    release: ResolvableModuleRelease;
  }>[];
  nextAfterReleaseRevision: Revision | null;
}>;

export type ResolvableConnectionTypeRelease = Readonly<{
  key: string;
  rootId: ConnectionTypeId;
  releaseVersion: SemanticVersion;
  contentFingerprint: Fingerprint;
  catalogueFingerprint: Fingerprint;
  compilationOutput: ConnectionOutput;
}>;

export interface DefinitionPublicationReader {
  readCandidate(rootId: string): Promise<DefinitionPublicationCandidate | undefined>;
  readModuleReleasePage(
    organizationId: OrganizationId,
    key: string,
    cursor?: ModuleReleasePageCursor,
  ): Promise<ResolvableModuleReleasePage>;
  readModuleRelease(
    organizationId: OrganizationId,
    rootId: ModuleRootId,
    releaseRevision: Revision,
  ): Promise<ResolvableModuleRelease | undefined>;
}

export interface DefinitionPublicationCatalogue {
  listConnectionTypeReleases(key: string): Promise<readonly ResolvableConnectionTypeRelease[]>;
  readConnectionTypeRelease(
    rootId: ConnectionTypeId,
    releaseVersion: string,
  ): Promise<ResolvableConnectionTypeRelease | undefined>;
  readPlatformBlockReleaseV2(
    blockId: BlockId,
    releaseVersion: string,
  ): Promise<PlatformBlockReleaseV2 | undefined>;
  readPlatformThemeReleaseV2(
    catalogueThemeId: PlatformId,
    releaseVersion: string,
  ): Promise<PlatformThemeReleaseV2 | undefined>;
  readApplicationCompositionCatalogueSnapshotV2(
    selection: Readonly<{
      platformBlocks: readonly Readonly<{
        blockId: BlockId;
        releaseVersion: SemanticVersion;
      }>[];
      platformTheme: Readonly<{
        catalogueThemeId: PlatformId;
        releaseVersion: SemanticVersion;
      }>;
    }>,
  ): Promise<ApplicationCompositionCatalogueSnapshotV2 | undefined>;
  readPlatformManagedFlowRelease?(
    flowId: string,
    releaseVersion: string,
  ): Promise<PlatformManagedFlowDependency | undefined>;
  readPlatformServiceOperationRelease?(
    serviceId: string,
    operationId: string,
    releaseVersion: string,
  ): Promise<PlatformServiceOperationRelease | undefined>;
}

export type DefinitionReleaseAppend = Readonly<{
  draft: StoredDefinitionDraft;
  compilationOutput: Exclude<DefinitionCompilationOutput, { kind: "connection_type" }>;
  assignedVersion: string;
  comparisonFingerprint: string;
  reasons: DefinitionPublicationConfirmation["reasons"];
  dependencyManifest: readonly ExactDefinitionDependency[];
  resolutionSnapshot: DefinitionResolution;
  validationContractVersion: "2.0.0" | "3.0.0";
  releaseNote: string;
}>;

export interface DefinitionPublicationTransaction extends DefinitionPublicationReader {
  /** Re-reads immediately before compilation; appendRelease owns the atomic row lock/check. */
  lockCandidate(rootId: string): Promise<DefinitionPublicationCandidate | undefined>;
  /** Must append the release and manifest and advance only this root's pointer atomically. */
  appendRelease(release: DefinitionReleaseAppend): Promise<PublishDefinitionResult>;
}

export interface DefinitionPublicationRepository {
  read<Result>(
    context: SessionContext,
    operation: (reader: DefinitionPublicationReader) => Promise<Result>,
  ): Promise<Result>;
  transaction<Result>(
    context: SessionContext,
    operation: (transaction: DefinitionPublicationTransaction) => Promise<Result>,
  ): Promise<Result>;
}

type PreparedState = Readonly<{
  confirmation: DefinitionPublicationConfirmation;
  draft: StoredDefinitionDraft;
  compilationOutput: Exclude<DefinitionCompilationOutput, { kind: "connection_type" }>;
  resolutionSnapshot: DefinitionResolution;
}>;

export type PreparedDefinitionPublication = PrepareDefinitionPublicationResult;

/** One current Application draft compiled at its exact revision, for exact-draft preview. */
export type ApplicationDraftCompilation = Readonly<{
  compilation: Extract<DefinitionCompilationOutput, { kind: "application" }>;
  /** The root's current published release revision; preview only labels it and never reads it. */
  currentReleaseRevision: Revision | null;
}>;

type Requirement = Readonly<{ key: string; version: VersionRequirement }>;

type ResolvedDependencies = Readonly<{
  modules: readonly ResolvableModuleRelease[];
  connections: readonly ResolvableConnectionTypeRelease[];
  compositionV2?: ApplicationCompositionCatalogueSnapshotV2;
  managedFlows: readonly PlatformManagedFlowDependency[];
  platformOperations: readonly PlatformServiceOperationRelease[];
}>;

const stable = (version: string): boolean =>
  stableDefinitionReleaseVersionSchema.safeParse(version).success;

const moduleOutputContractVersion = (output: ModuleOutput): "3.0.0" =>
  output.validationContractVersion;

const accepts = (requirements: readonly VersionRequirement[], version: string): boolean =>
  requirements.every((requirement) =>
    requirement.selection === "exact"
      ? requirement.version === version
      : satisfies(version, requirement.expression, { includePrerelease: false }),
  );

const groupRequirements = (requirements: readonly Requirement[]) => {
  const grouped = new Map<string, VersionRequirement[]>();
  for (const requirement of requirements)
    grouped.set(requirement.key, [...(grouped.get(requirement.key) ?? []), requirement.version]);
  return [...grouped].sort(([left], [right]) => compareCanonicalStrings(left, right));
};

const chooseStableRelease = <Release extends { releaseVersion: string }>(
  releases: readonly Release[],
  requirements: readonly VersionRequirement[],
): Release => {
  if (releases.length === 0) return refuse("DEFINITION_DEPENDENCY_MISSING");
  const stableReleases = releases.filter((release) => stable(release.releaseVersion));
  if (stableReleases.length === 0) return refuse("DEFINITION_DEPENDENCY_PRERELEASE_ONLY");
  const compatible = stableReleases.filter((release) =>
    accepts(requirements, release.releaseVersion),
  );
  if (compatible.length === 0) return refuse("DEFINITION_DEPENDENCY_INCOMPATIBLE");
  const highestVersion = compatible
    .map((release) => release.releaseVersion)
    .sort(compare)
    .at(-1)!;
  const highest = compatible.filter((release) => release.releaseVersion === highestVersion);
  if (highest.length !== 1) return refuse("DEFINITION_DEPENDENCY_AMBIGUOUS");
  return highest[0]!;
};

type ModuleSelectionFold = {
  sawRelease: boolean;
  sawStable: boolean;
  sawCompatible: boolean;
  best: ResolvableModuleRelease | undefined;
  bestMultiplicity: number;
};

const createModuleSelectionFold = (): ModuleSelectionFold => ({
  sawRelease: false,
  sawStable: false,
  sawCompatible: false,
  best: undefined,
  bestMultiplicity: 0,
});

const foldModuleSelection = (
  fold: ModuleSelectionFold,
  release: ResolvableModuleRelease,
  requirements: readonly VersionRequirement[],
): void => {
  fold.sawRelease = true;
  if (!stable(release.releaseVersion)) return;
  fold.sawStable = true;
  if (!accepts(requirements, release.releaseVersion)) return;
  fold.sawCompatible = true;
  if (fold.best === undefined || compare(release.releaseVersion, fold.best.releaseVersion) > 0) {
    fold.best = release;
    fold.bestMultiplicity = 1;
  } else if (release.releaseVersion === fold.best.releaseVersion) {
    fold.bestMultiplicity += 1;
  }
};

const completeModuleSelection = (fold: ModuleSelectionFold): ResolvableModuleRelease => {
  if (!fold.sawRelease) return refuse("DEFINITION_DEPENDENCY_MISSING");
  if (!fold.sawStable) return refuse("DEFINITION_DEPENDENCY_PRERELEASE_ONLY");
  if (!fold.sawCompatible || fold.best === undefined)
    return refuse("DEFINITION_DEPENDENCY_INCOMPATIBLE");
  if (fold.bestMultiplicity !== 1) return refuse("DEFINITION_DEPENDENCY_AMBIGUOUS");
  return fold.best;
};

const moduleRequirements = (draft: StoredDefinitionDraft): Requirement[] => {
  const dependencies =
    draft.source.kind === "module"
      ? draft.source.body.dependencies
      : draft.source.body.module_bindings;
  return dependencies.map((entry) => ({ key: entry.module, version: entry.version }));
};

const connectionRequirements = (draft: StoredDefinitionDraft): Requirement[] =>
  draft.source.kind === "application"
    ? draft.source.body.connection_bindings.map((entry) => ({
        key: entry.connection_type,
        version: entry.version,
      }))
    : [];

const subjectOf = (dependency: ExactDefinitionDependency): string =>
  dependency.kind === "platform_theme"
    ? `${dependency.kind}:${dependency.catalogueThemeId}`
    : dependency.kind === "platform_block"
      ? `${dependency.kind}:${dependency.blockId}`
      : dependency.kind === "platform_flow"
        ? `${dependency.kind}:${dependency.flowId}`
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

const sortedManifest = (
  dependencies: readonly ExactDefinitionDependency[],
): ExactDefinitionDependency[] =>
  [...dependencies].sort((left, right) =>
    compareCanonicalStrings(subjectOf(left), subjectOf(right)),
  );

const verifyModuleRelease = (
  candidate: ValidatedDefinitionPublicationCandidate,
  expectedKey: string,
  release: ResolvableModuleRelease,
): void => {
  const parsedOutput = definitionCompilationOutputSchema.safeParse(release.compilationOutput);
  const publication = release.published.publication;
  try {
    assertModuleContractPair(
      moduleOutputContractVersion(release.compilationOutput),
      publication.validationContractVersion,
    );
  } catch {
    return refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
  }
  const parsedResolution = definitionResolutionSnapshotV3Schema.safeParse(
    release.resolutionSnapshot,
  );
  const ownResolution = parsedResolution.success
    ? parsedResolution.data.definitions.filter(
        (definition) =>
          definition.kind === "module" &&
          definition.key === release.key &&
          definition.rootId === release.rootId &&
          definition.exactVersion === release.releaseVersion,
      )
    : [];
  const authenticResolutionFingerprint = parsedResolution.success
    ? fingerprintCanonicalValue({
        contractVersion: parsedResolution.data.contractVersion,
        definitions: parsedResolution.data.definitions,
        identities: parsedResolution.data.identities,
      })
    : undefined;
  if (
    release.organizationId !== candidate.draft.organizationId ||
    release.key !== expectedKey ||
    !parsedOutput.success ||
    parsedOutput.data.kind !== "module" ||
    !parsedResolution.success ||
    moduleOutputContractVersion(parsedOutput.data) !== publication.validationContractVersion ||
    ownResolution.length !== 1 ||
    authenticResolutionFingerprint !== release.resolutionFingerprint ||
    publication.kind !== "module" ||
    publication.rootId !== release.rootId ||
    publication.revision !== release.releaseRevision ||
    publication.releaseVersion !== release.releaseVersion ||
    publication.contentFingerprint !== release.contentFingerprint ||
    release.compilationOutput.artifact.rootId !== release.rootId ||
    release.compilationOutput.canonical.envelope.key !== release.key ||
    release.compilationOutput.artifact.exactVersion !== release.releaseVersion ||
    release.compilationOutput.artifact.contentFingerprint !== release.contentFingerprint ||
    release.resolutionSnapshot.fingerprint !== release.resolutionFingerprint ||
    release.compilationOutput.artifact.resolutionFingerprint !== release.resolutionFingerprint ||
    release.compilationOutput.resolutionFingerprint !== release.resolutionFingerprint ||
    fingerprintCanonicalValue(release.published.content) !== release.contentFingerprint
  )
    refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
};

const sameModuleReleaseLocator = (
  left: ResolvableModuleRelease,
  right: ResolvableModuleRelease,
): boolean =>
  left.organizationId === right.organizationId &&
  left.key === right.key &&
  left.rootId === right.rootId &&
  left.releaseRevision === right.releaseRevision &&
  left.releaseVersion === right.releaseVersion &&
  left.contentFingerprint === right.contentFingerprint &&
  left.resolutionFingerprint === right.resolutionFingerprint;

const selectModuleRelease = async (
  reader: DefinitionPublicationReader,
  candidate: ValidatedDefinitionPublicationCandidate,
  key: string,
  requirements: readonly VersionRequirement[],
): Promise<ResolvableModuleRelease> => {
  const selection = createModuleSelectionFold();
  let cursor: ModuleReleasePageCursor | undefined;
  let anchoredRootId: ModuleRootId | undefined;
  let anchoredRevision: Revision | undefined;
  let previousReleaseRevision: Revision | null = null;
  while (true) {
    const page = await reader.readModuleReleasePage(candidate.draft.organizationId, key, cursor);
    if (page.entries.length > 100) refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
    if (cursor === undefined) {
      if (page.rootId === null || page.anchorReleaseRevision === null) {
        if (
          page.rootId !== null ||
          page.anchorReleaseRevision !== null ||
          page.entries.length !== 0 ||
          page.nextAfterReleaseRevision !== null
        )
          refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
        break;
      }
      anchoredRootId = page.rootId;
      anchoredRevision = page.anchorReleaseRevision;
    } else if (
      page.rootId !== cursor.rootId ||
      page.anchorReleaseRevision !== cursor.anchorReleaseRevision
    ) {
      refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
    }
    if (
      anchoredRootId === undefined ||
      anchoredRevision === undefined ||
      page.rootId !== anchoredRootId ||
      page.anchorReleaseRevision !== anchoredRevision ||
      page.entries.length === 0
    )
      refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
    const currentRootId = anchoredRootId as ModuleRootId;
    const currentAnchorRevision = anchoredRevision as Revision;
    for (const entry of page.entries) {
      const release = entry.release;
      if (
        entry.previousReleaseRevision !== previousReleaseRevision ||
        release.rootId !== currentRootId ||
        release.releaseRevision <= (previousReleaseRevision ?? 0) ||
        release.releaseRevision > currentAnchorRevision
      )
        refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
      verifyModuleRelease(candidate, key, release);
      foldModuleSelection(selection, release, requirements);
      previousReleaseRevision = release.releaseRevision;
    }
    const last = previousReleaseRevision;
    if (page.nextAfterReleaseRevision === null) {
      if (last !== currentAnchorRevision) refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
      break;
    }
    if (
      last === null ||
      page.nextAfterReleaseRevision !== last ||
      page.nextAfterReleaseRevision >= currentAnchorRevision
    )
      refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
    cursor = {
      rootId: currentRootId,
      anchorReleaseRevision: currentAnchorRevision,
      afterReleaseRevision: page.nextAfterReleaseRevision,
    };
  }
  const selected = completeModuleSelection(selection);
  const exact = await reader.readModuleRelease(
    candidate.draft.organizationId,
    selected.rootId,
    selected.releaseRevision,
  );
  if (exact === undefined || !sameModuleReleaseLocator(selected, exact))
    return refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
  verifyModuleRelease(candidate, key, exact as ResolvableModuleRelease);
  return exact as ResolvableModuleRelease;
};

const verifyConnectionRelease = (
  expectedKey: string,
  release: ResolvableConnectionTypeRelease,
): void => {
  const output = definitionCompilationOutputSchema.safeParse(release.compilationOutput);
  if (
    release.key !== expectedKey ||
    !stable(release.releaseVersion) ||
    !output.success ||
    output.data.kind !== "connection_type" ||
    output.data.canonical.key !== release.key ||
    output.data.artifact.rootId !== release.rootId ||
    output.data.artifact.exactVersion !== release.releaseVersion ||
    output.data.artifact.contentFingerprint !== release.contentFingerprint ||
    fingerprintCanonicalValue(output.data.canonical) !== release.contentFingerprint
  )
    refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
};

const findPinned = <Kind extends ExactDefinitionDependency["kind"]>(
  manifest: readonly ExactDefinitionDependency[],
  kind: Kind,
  subject: string,
): Extract<ExactDefinitionDependency, { kind: Kind }> => {
  const matches = manifest.filter(
    (entry) =>
      entry.kind === kind &&
      (entry.kind === "platform_theme"
        ? entry.catalogueThemeId === subject
        : entry.kind === "platform_block"
          ? entry.blockId === subject
          : entry.kind === "platform_flow"
            ? String(entry.flowId) === subject
            : entry.kind === "protected_operation"
              ? entry.operation.operationId === subject
          : entry.key === subject),
  );
  if (matches.length !== 1) return refuse("DEFINITION_CONFIRMATION_MISMATCH");
  return matches[0] as Extract<ExactDefinitionDependency, { kind: Kind }>;
};

const resolveApplicationCompositionV2 = async (
  source: ApplicationSourceDocumentV2,
  catalogue: DefinitionPublicationCatalogue,
  pinned?: readonly ExactDefinitionDependency[],
): Promise<ApplicationCompositionCatalogueSnapshotV2> => {
  const selection = {
    platformBlocks: source.body.platform_block_dependencies.map((dependency) => ({
      blockId: dependency.block_id,
      releaseVersion: dependency.release_version,
    })),
    platformTheme: {
      catalogueThemeId: source.body.theme.base.catalogue_theme_id,
      releaseVersion: source.body.theme.base.release_version,
    },
  };
  const candidate = await catalogue.readApplicationCompositionCatalogueSnapshotV2(selection);
  if (candidate === undefined) return refuse("DEFINITION_DEPENDENCY_MISSING");
  const parsed = applicationCompositionCatalogueSnapshotV2Schema.safeParse(candidate);
  if (!parsed.success) return refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
  const snapshot = parsed.data;
  const fingerprint = fingerprintCanonicalValue({
    contractVersion: snapshot.contractVersion,
    platformBlocks: snapshot.platformBlocks,
    platformTheme: snapshot.platformTheme,
  });
  if (snapshot.fingerprint !== fingerprint) refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
  const blocks = new Map(
    snapshot.platformBlocks.releases.map((release) => [String(release.blockId), release] as const),
  );
  if (blocks.size !== source.body.platform_block_dependencies.length)
    refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
  for (const authored of source.body.platform_block_dependencies) {
    const release = blocks.get(String(authored.block_id));
    if (
      release === undefined ||
      !stable(release.releaseVersion) ||
      release.releaseVersion !== authored.release_version ||
      release.contentFingerprint !== authored.content_fingerprint ||
      release.catalogueFingerprint !== authored.catalogue_fingerprint
    )
      return refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
    if (pinned !== undefined) {
      const exact = findPinned(pinned, "platform_block", String(authored.block_id));
      if (
        exact.releaseVersion !== release.releaseVersion ||
        exact.contentFingerprint !== release.contentFingerprint ||
        exact.catalogueFingerprint !== release.catalogueFingerprint
      )
        refuse("DEFINITION_CONFIRMATION_MISMATCH");
    }
  }
  const base = source.body.theme.base;
  if (
    snapshot.platformTheme.catalogueThemeId !== base.catalogue_theme_id ||
    snapshot.platformTheme.releaseVersion !== base.release_version ||
    snapshot.platformTheme.contentFingerprint !== base.content_fingerprint ||
    snapshot.platformTheme.catalogueFingerprint !== base.catalogue_fingerprint ||
    !stable(snapshot.platformTheme.releaseVersion)
  )
    refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
  if (pinned !== undefined) {
    const exact = findPinned(pinned, "platform_theme", String(base.catalogue_theme_id));
    if (
      exact.releaseVersion !== snapshot.platformTheme.releaseVersion ||
      exact.contentFingerprint !== snapshot.platformTheme.contentFingerprint ||
      exact.catalogueFingerprint !== snapshot.platformTheme.catalogueFingerprint
    )
      refuse("DEFINITION_CONFIRMATION_MISMATCH");
  }
  return snapshot;
};

const resolveDependencies = async (
  reader: DefinitionPublicationReader,
  catalogue: DefinitionPublicationCatalogue,
  candidate: ValidatedDefinitionPublicationCandidate,
  pinned?: readonly ExactDefinitionDependency[],
): Promise<ResolvedDependencies> => {
  const modules: ResolvableModuleRelease[] = [];
  for (const [key, requirements] of groupRequirements(moduleRequirements(candidate.draft))) {
    let release: ResolvableModuleRelease | undefined;
    if (pinned === undefined) {
      release = await selectModuleRelease(reader, candidate, key, requirements);
    } else {
      const exact = findPinned(pinned, "module", key);
      if (!accepts(requirements, exact.releaseVersion)) refuse("DEFINITION_CONFIRMATION_MISMATCH");
      release = await reader.readModuleRelease(
        candidate.draft.organizationId,
        exact.rootId,
        exact.releaseRevision,
      );
      if (
        release === undefined ||
        release.releaseVersion !== exact.releaseVersion ||
        release.contentFingerprint !== exact.contentFingerprint ||
        release.resolutionFingerprint !== exact.resolutionFingerprint
      )
        refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
    }
    if (release === undefined) refuse("DEFINITION_DEPENDENCY_MISSING");
    const resolvedRelease = release as ResolvableModuleRelease;
    verifyModuleRelease(candidate, key, resolvedRelease);
    modules.push(resolvedRelease);
  }

  const connections: ResolvableConnectionTypeRelease[] = [];
  for (const [key, requirements] of groupRequirements(connectionRequirements(candidate.draft))) {
    let release: ResolvableConnectionTypeRelease | undefined;
    if (pinned === undefined) {
      release = chooseStableRelease(await catalogue.listConnectionTypeReleases(key), requirements);
    } else {
      const exact = findPinned(pinned, "connection_type", key);
      if (!accepts(requirements, exact.releaseVersion)) refuse("DEFINITION_CONFIRMATION_MISMATCH");
      release = await catalogue.readConnectionTypeRelease(exact.rootId, exact.releaseVersion);
      if (
        release === undefined ||
        release.contentFingerprint !== exact.contentFingerprint ||
        release.catalogueFingerprint !== exact.catalogueFingerprint
      )
        refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
    }
    if (release === undefined) refuse("DEFINITION_DEPENDENCY_MISSING");
    const resolvedRelease = release as ResolvableConnectionTypeRelease;
    verifyConnectionRelease(key, resolvedRelease);
    connections.push(resolvedRelease);
  }

  let compositionV2: ApplicationCompositionCatalogueSnapshotV2 | undefined;
  if (candidate.draft.source.kind === "application")
    compositionV2 = await resolveApplicationCompositionV2(
      candidate.draft.source,
      catalogue,
      pinned,
    );

  const managedFlows: PlatformManagedFlowDependency[] = [];
  const managedFlowSubjects = new Set<string>();
  const platformOperations: PlatformServiceOperationRelease[] = [];
  const platformOperationSubjects = new Set<string>();
  if (candidate.draft.source.kind === "application") {
    for (const binding of candidate.draft.source.body.flow_bindings) {
      if (binding.flow.kind !== "platform_managed") continue;
      const release = await catalogue.readPlatformManagedFlowRelease?.(
        binding.flow.flow_id,
        binding.flow.release_version,
      );
      if (
        release === undefined ||
        release.kind !== "platform_flow" ||
        release.flowId !== binding.flow.flow_id ||
        release.releaseVersion !== binding.flow.release_version
      )
        refuse("DEFINITION_DEPENDENCY_MISSING");
      if (pinned !== undefined) {
        const exact = findPinned(pinned, "platform_flow", String(binding.flow.flow_id));
        if (
          exact.releaseVersion !== release.releaseVersion ||
          exact.contentFingerprint !== release.contentFingerprint ||
          exact.catalogueFingerprint !== release.catalogueFingerprint
        )
          refuse("DEFINITION_CONFIRMATION_MISMATCH");
      }
      const subject = `${release.flowId}:${release.releaseVersion}`;
      if (!managedFlowSubjects.has(subject)) {
        managedFlowSubjects.add(subject);
        managedFlows.push(release);
      }
    }
    for (const flow of candidate.draft.source.body.flows) {
      for (const node of flow.nodes) {
        if (node.kind !== "action" || node.target.kind !== "protected_operation") continue;
        const owner = node.target.operation.owner;
        if (owner.kind !== "platform_service") continue;
        const release = await catalogue.readPlatformServiceOperationRelease?.(
          owner.serviceId,
          node.target.operation.operationId,
          node.target.release_version!,
        );
        if (
          release === undefined ||
          release.serviceId !== owner.serviceId ||
          release.operationId !== node.target.operation.operationId ||
          release.releaseVersion !== node.target.release_version
        )
          refuse(
            release === undefined
              ? "DEFINITION_DEPENDENCY_MISSING"
              : "DEFINITION_DEPENDENCY_SUBSTITUTED",
          );
        if (pinned !== undefined) {
          const exact = pinned.filter(
            (dependency) =>
              dependency.kind === "protected_operation" &&
              dependency.operation.owner.kind === "platform_service" &&
              dependency.operation.owner.serviceId === owner.serviceId &&
              dependency.operation.operationId === node.target.operation.operationId,
          );
          if (exact.length !== 1) refuse("DEFINITION_CONFIRMATION_MISMATCH");
          const pinnedOperation = exact[0]!;
          if (
            pinnedOperation.releaseVersion !== release.releaseVersion ||
            pinnedOperation.contentFingerprint !== release.contentFingerprint ||
            pinnedOperation.catalogueFingerprint !== release.catalogueFingerprint
          )
            refuse("DEFINITION_CONFIRMATION_MISMATCH");
        }
        const subject = `${release.serviceId}:${release.operationId}:${release.releaseVersion}`;
        if (!platformOperationSubjects.has(subject)) {
          platformOperationSubjects.add(subject);
          platformOperations.push(release);
        }
      }
    }
  }

  const expectedSubjects = [
    ...modules.map((release) => `module:${release.key}`),
    ...connections.map((release) => `connection_type:${release.key}`),
    ...(compositionV2 === undefined
      ? []
      : [
          ...compositionV2.platformBlocks.releases.map(
            (release) => `platform_block:${release.blockId}`,
          ),
          `platform_theme:${compositionV2.platformTheme.catalogueThemeId}`,
        ]),
  ].sort(compareCanonicalStrings);
  if (
    pinned !== undefined &&
    JSON.stringify(
      [...pinned]
        .filter((dependency) =>
          ["module", "connection_type", "platform_block", "platform_theme"].includes(
            dependency.kind,
          ),
        )
        .map(subjectOf)
        .sort(compareCanonicalStrings),
    ) !==
      JSON.stringify(expectedSubjects)
  )
    refuse("DEFINITION_CONFIRMATION_MISMATCH");
  return {
    modules,
    connections,
    managedFlows,
    platformOperations,
    ...(compositionV2 === undefined ? {} : { compositionV2 }),
  };
};

const assertNoCycle = async (
  reader: DefinitionPublicationReader,
  candidate: ValidatedDefinitionPublicationCandidate,
  modules: readonly ResolvableModuleRelease[],
): Promise<void> => {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = async (release: ResolvableModuleRelease): Promise<void> => {
    if (String(release.rootId) === String(candidate.draft.rootId))
      refuse("DEFINITION_DEPENDENCY_CYCLE");
    const reference = `${release.rootId}:${release.releaseRevision}`;
    if (visiting.has(reference)) refuse("DEFINITION_DEPENDENCY_CYCLE");
    if (visited.has(reference)) return;
    visiting.add(reference);
    for (const dependency of release.published.dependencyManifest) {
      if (dependency.kind !== "module") refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
      const moduleDependency = dependency as Extract<
        (typeof release.published.dependencyManifest)[number],
        { kind: "module" }
      >;
      const child = await reader.readModuleRelease(
        candidate.draft.organizationId,
        moduleDependency.rootId,
        moduleDependency.revision,
      );
      if (
        child === undefined ||
        child.releaseVersion !== moduleDependency.releaseVersion ||
        child.contentFingerprint !== moduleDependency.contentFingerprint
      )
        refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
      if (child === undefined) refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
      const resolvedChild = child as ResolvableModuleRelease;
      verifyModuleRelease(candidate, resolvedChild.key, resolvedChild);
      await visit(resolvedChild);
    }
    visiting.delete(reference);
    visited.add(reference);
  };
  for (const module of modules) await visit(module);
};

const flowTargetManifestFor = (
  output: Exclude<DefinitionCompilationOutput, { kind: "connection_type" }>,
): ExactDefinitionDependency[] => {
  if (output.kind !== "application") return [];
  const entries: ExactDefinitionDependency[] = [];
  const bySubject = new Map<string, ExactDefinitionDependency>();
  const add = (entry: ExactDefinitionDependency): void => {
    const subject = subjectOf(entry);
    const existing = bySubject.get(subject);
    if (existing !== undefined) {
      if (fingerprintCanonicalValue(existing) !== fingerprintCanonicalValue(entry))
        refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
      return;
    }
    bySubject.set(subject, entry);
    entries.push(entry);
  };
  const content = output.canonical.content;
  const applicationRootId = output.canonical.envelope.rootId;
  for (const flow of content.flows) {
    add({
      kind: "application_flow",
      applicationRootId,
      flowId: flow.flowId,
      releaseVersion: flow.releaseVersion,
      contentFingerprint: flow.contentFingerprint,
      resolutionFingerprint: flow.resolutionFingerprint,
    });
    for (const node of flow.nodes)
      add({
        kind: "application_flow_node",
        applicationRootId,
        flowId: flow.flowId,
        nodeId: node.nodeId,
        releaseVersion: flow.releaseVersion,
        contentFingerprint: fingerprintCanonicalValue({ kind: "flow_node", node }),
        resolutionFingerprint: flow.resolutionFingerprint,
      });
    for (const node of flow.nodes) {
      const target = (node as { target?: Record<string, unknown> }).target;
      if (target === undefined) continue;
      const targetKind = String(target.kind);
      if (targetKind === "application_query")
        add({
          kind: "application_query",
          applicationRootId,
          queryId: String(target.queryId),
          releaseVersion: String(target.releaseVersion),
          contentFingerprint: String(target.contentFingerprint),
          resolutionFingerprint: String(target.resolutionFingerprint),
        });
      else if (targetKind === "query")
        add({
          kind: "module_query",
          moduleRootId: String(target.moduleRootId),
          queryId: String(target.queryId),
          declaredRequirement: target.declaredRequirement as never,
          releaseVersion: String(target.moduleReleaseVersion),
          contentFingerprint: String(target.contentFingerprint),
          resolutionFingerprint: String(target.resolutionFingerprint),
        });
      else if (targetKind === "protected_operation")
        add({
          kind: "protected_operation",
          operation: target.operation as never,
          releaseVersion: String(target.releaseVersion),
          contentFingerprint: String(target.contentFingerprint),
          resolutionFingerprint: String(target.resolutionFingerprint),
          ...(target.catalogueFingerprint === undefined
            ? {}
            : { catalogueFingerprint: String(target.catalogueFingerprint) }),
        });
      else if (targetKind === "form_continuation")
        add({
          kind: "application_form",
          applicationRootId,
          formId: String(target.formId),
          releaseVersion: String(target.releaseVersion),
          contentFingerprint: String(target.contentFingerprint),
          resolutionFingerprint: String(target.resolutionFingerprint),
        });
      else if (targetKind === "durable_workflow_start")
        add({
          kind: "application_workflow",
          applicationRootId,
          workflowId: String(target.workflowId),
          releaseVersion: String(target.releaseVersion),
          contentFingerprint: String(target.contentFingerprint),
          resolutionFingerprint: String(target.resolutionFingerprint),
        });
      else if (targetKind === "application_action")
        add({
          kind: "application_action",
          applicationRootId,
          actionId: String(target.actionId),
          releaseVersion: String(target.releaseVersion),
          contentFingerprint: String(target.contentFingerprint),
          resolutionFingerprint: String(target.resolutionFingerprint),
        });
      // A record save adds no entry of its own: its record type belongs to a Module release the
      // Module binding already pins exactly.
    }
  }
  for (const binding of content.flowBindings) {
    if (binding.flow.kind === "application_owned")
      add({
        kind: "application_flow",
        applicationRootId,
        flowId: binding.flow.flowId,
        releaseVersion: binding.flow.releaseVersion,
        contentFingerprint: binding.flow.contentFingerprint,
        resolutionFingerprint: binding.flow.resolutionFingerprint,
      });
    else
      add({
        kind: "platform_flow",
        flowId: binding.flow.flowId,
        releaseVersion: binding.flow.releaseVersion,
        contentFingerprint: binding.flow.contentFingerprint,
        catalogueFingerprint: binding.flow.catalogueFingerprint,
      });
  }
  return entries;
};

const manifestFor = (
  dependencies: ResolvedDependencies,
  output: Exclude<DefinitionCompilationOutput, { kind: "connection_type" }>,
): ExactDefinitionDependency[] =>
  sortedManifest([
    ...dependencies.modules.map((release) => ({
      kind: "module" as const,
      key: release.key,
      rootId: release.rootId,
      releaseRevision: release.releaseRevision,
      releaseVersion: release.releaseVersion,
      contentFingerprint: release.contentFingerprint,
      resolutionFingerprint: release.resolutionFingerprint,
    })),
    ...dependencies.connections.map((release) => ({
      kind: "connection_type" as const,
      key: release.key,
      rootId: release.rootId,
      releaseVersion: release.releaseVersion,
      contentFingerprint: release.contentFingerprint,
      catalogueFingerprint: release.catalogueFingerprint,
    })),
    ...(dependencies.compositionV2 === undefined
      ? []
      : [
          ...dependencies.compositionV2.platformBlocks.releases.map((release) => ({
            kind: "platform_block" as const,
            blockId: release.blockId,
            releaseVersion: release.releaseVersion,
            contentFingerprint: release.contentFingerprint,
            catalogueFingerprint: release.catalogueFingerprint,
          })),
          {
            kind: "platform_theme" as const,
            catalogueThemeId: dependencies.compositionV2.platformTheme.catalogueThemeId,
            releaseVersion: dependencies.compositionV2.platformTheme.releaseVersion,
            contentFingerprint: dependencies.compositionV2.platformTheme.contentFingerprint,
            catalogueFingerprint: dependencies.compositionV2.platformTheme.catalogueFingerprint,
          },
        ]),
    ...flowTargetManifestFor(output),
  ]);

const buildResolution = (
  candidate: ValidatedDefinitionPublicationCandidate,
  dependencies: ResolvedDependencies,
  ownVersion: string,
): DefinitionResolution => {
  const ownDefinition: DefinitionResolutionSnapshotV2["definitions"][number] =
    candidate.draft.kind === "module"
      ? {
          kind: "module",
          key: candidate.draft.key,
          rootId: candidate.draft.rootId,
          exactVersion: ownVersion,
        }
      : {
          kind: "application",
          key: candidate.draft.key,
          rootId: candidate.draft.rootId,
          exactVersion: ownVersion,
        };
  const definitions: DefinitionResolutionSnapshotV2["definitions"] = [
    ownDefinition,
    ...dependencies.modules.map((release) => ({
      kind: "module" as const,
      key: release.key,
      rootId: release.rootId,
      exactVersion: release.releaseVersion,
    })),
    ...dependencies.connections.map((release) => ({
      kind: "connection_type" as const,
      key: release.key,
      rootId: release.rootId,
      exactVersion: release.releaseVersion,
      operationKeys: release.compilationOutput.canonical.operations.map(
        (operation) => operation.key,
      ),
    })),
  ].sort((left, right) =>
    compareCanonicalStrings(`${left.kind}:${left.key}`, `${right.kind}:${right.key}`),
  );
  const allIdentities = [
    ...candidate.identities,
    ...dependencies.modules.flatMap((release) =>
      release.resolutionSnapshot.identities.filter(
        (identity) => identity.definitionKey === release.key,
      ),
    ),
  ].sort((left, right) =>
    compareCanonicalStrings(
      JSON.stringify([
        left.definitionKey,
        left.scope,
        left.kind,
        left.componentOwner,
        left.alias,
        left.identifier,
      ]),
      JSON.stringify([
        right.definitionKey,
        right.scope,
        right.kind,
        right.componentOwner,
        right.alias,
        right.identifier,
      ]),
    ),
  );
  if (candidate.draft.source.kind === "module") {
    const evidence = { contractVersion: "3.0.0" as const, definitions, identities: allIdentities };
    return definitionResolutionSnapshotV3Schema.parse({
      ...evidence,
      fingerprint: fingerprintCanonicalValue(evidence),
    });
  }
  return createApplicationResolutionSnapshotV2({
    definitions,
    identities: allIdentities.filter(
      (identity): identity is DefinitionResolutionSnapshotV2["identities"][number] =>
        sourceIdentityKindV2Schema.safeParse(identity.kind).success,
    ),
  });
};

const draftMetadata = (draft: StoredDefinitionDraft) => ({
  organizationId: draft.organizationId,
  draftRevision: draft.draftRevision,
  ...(draft.publishedRevision === undefined ? {} : { publishedRevision: draft.publishedRevision }),
  createdAt: draft.createdAt,
  createdBy: draft.createdBy,
  updatedAt: draft.updatedAt,
  updatedBy: draft.updatedBy,
});

const provisionalSavedConditionRevisions = (
  candidate: ValidatedDefinitionPublicationCandidate,
): SavedConditionRevisionAssignment[] => {
  if (candidate.draft.kind !== "module") return [];
  const conditions = candidate.draft.source.body.sharing_conditions;
  return conditions.map((condition) => {
    const matches = candidate.identities.filter(
      (identity) =>
        identity.definitionKey === candidate.draft.key &&
        identity.kind === "sharing_condition" &&
        identity.componentOwner === condition.id,
    );
    const identifiers = [...new Set(matches.map((identity) => identity.identifier))];
    if (identifiers.length !== 1) refuse("DEFINITION_COMPILATION_REFUSED");
    return savedConditionRevisionAssignmentSchema.parse({
      conditionId: identifiers[0]!,
      revision: 1,
    });
  });
};

/**
 * The request parse compileDefinitionWithContext performed for the requests this service
 * assembles. compileParsedDefinition takes a parsed request, so the parse happens here, with the
 * schema that entry point would have selected, and refuses in the same way.
 */
const parsedCompilationRequest = <Schema extends z.ZodType>(
  schema: Schema,
  request: unknown,
): z.output<Schema> => {
  const parsed = schema.safeParse(request);
  if (!parsed.success)
    throw new DefinitionCompilationError(
      "vortex.definition.invalid_compilation_request",
      "invalid_value",
    );
  return parsed.data;
};

const assertFinalPublicationValidation = (
  request:
    | z.output<typeof applicationCompilationRequestV2Schema>
    | z.output<typeof moduleCompilationRequestV3Schema>,
  output: Exclude<DefinitionCompilationOutput, { kind: "connection_type" }>,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
  historyEvidence: DefinitionPublicationHistoryEvidence,
): void => {
  const validation = validateDefinitionSet({
    requests: [request],
    outputs: [output],
    dependencyOutputs,
    publishedHistoryEvidence: [historyEvidence],
  });
  if (!validation.valid) {
    const first = validation.failures[0]!;
    throw new DefinitionCompilationError(first.ruleCode, first.family, first.location);
  }
};

const compileCandidate = (
  candidate: ValidatedDefinitionPublicationCandidate,
  dependencies: ResolvedDependencies,
  resolution: DefinitionResolution,
  final: boolean,
): Exclude<DefinitionCompilationOutput, { kind: "connection_type" }> => {
  const dependencyOutputs = [
    ...dependencies.modules.map((release) => release.compilationOutput),
    ...dependencies.connections.map((release) => release.compilationOutput),
  ].map((output) => definitionCompilationOutputSchema.parse(output));
  if (candidate.draft.source.kind === "application") {
    if (resolution.contractVersion !== "2.0.0" || dependencies.compositionV2 === undefined)
      return refuse("DEFINITION_COMPILATION_REFUSED");
    const request = {
      sourceContractVersion: "2.0.0" as const,
      validationContractVersion: "2.0.0" as const,
      source: candidate.draft.source,
      resolution,
      catalogueSnapshot: dependencies.compositionV2,
      draftMetadata: draftMetadata(candidate.draft),
    };
    const output = compileParsedDefinition(
      parsedCompilationRequest(applicationCompilationRequestV2Schema, request),
      dependencyOutputs,
      {
        managedFlows: dependencies.managedFlows,
        platformOperations: dependencies.platformOperations,
      },
    );
    if (final)
      assertFinalPublicationValidation(
        parsedCompilationRequest(applicationCompilationRequestV2Schema, request),
        output,
        dependencyOutputs,
        candidate.historyEvidence,
      );
    return output;
  }
  if (candidate.draft.source.kind === "module") {
    if (resolution.contractVersion !== "3.0.0") return refuse("DEFINITION_COMPILATION_REFUSED");
    const common = {
      sourceContractVersion: "3.0.0" as const,
      validationContractVersion: "3.0.0" as const,
      source: candidate.draft.source,
      resolution,
      draftMetadata: draftMetadata(candidate.draft),
    };
    const provisional = compileParsedDefinition(
      parsedCompilationRequest(moduleCompilationRequestV3Schema, {
        ...common,
        savedConditionRevisions: provisionalSavedConditionRevisions(candidate),
      }),
      dependencyOutputs,
    );
    if (
      provisional.kind !== "module" ||
      !("validationContractVersion" in provisional) ||
      provisional.validationContractVersion !== "3.0.0"
    )
      return refuse("DEFINITION_COMPILATION_REFUSED");
    if (candidate.historyEvidence.kind !== "module") return refuse("DEFINITION_HISTORY_INVALID");
    const savedConditionRevisions = deriveSavedConditionRevisionsFromHistoryEvidence(
      candidate.historyEvidence,
      candidate.draft.rootId,
      provisional.canonical.content.sharingConditions,
    );
    const request = { ...common, savedConditionRevisions };
    if (!final)
      return compileParsedDefinition(
        parsedCompilationRequest(moduleCompilationRequestV3Schema, request),
        dependencyOutputs,
      );
    const parsedRequest = parsedCompilationRequest(moduleCompilationRequestV3Schema, request);
    const output = compileParsedDefinition(parsedRequest, dependencyOutputs);
    if (
      output === undefined ||
      output.kind !== "module" ||
      !("validationContractVersion" in output) ||
      output.validationContractVersion !== "3.0.0"
    )
      return refuse("DEFINITION_COMPILATION_REFUSED");
    assertFinalPublicationValidation(
      parsedRequest,
      output,
      dependencyOutputs,
      candidate.historyEvidence,
    );
    return output;
  }
  // Only an Application or a Module is a customer-publishable definition, and each has exactly
  // one current source/validation contract pair. A stored draft of any other shape is refused.
  return refuse("DEFINITION_COMPILATION_REFUSED");
};

const validateCandidate = (
  context: SessionContext,
  candidateInput: DefinitionPublicationCandidate | undefined,
  command: PrepareDefinitionPublicationCommand,
): ValidatedDefinitionPublicationCandidate => {
  if (candidateInput === undefined) return refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
  const supplied = candidateInput;
  const draft = storedDefinitionDraftSchema.safeParse(supplied.draft);
  if (!draft.success || !isVerifiedDefinitionPublicationHistoryEvidence(supplied.historyEvidence))
    return refuse("DEFINITION_HISTORY_INVALID");
  const candidate: ValidatedDefinitionPublicationCandidate = {
    draft: draft.data,
    identities: supplied.identities,
    historyEvidence: supplied.historyEvidence,
  };
  if (candidate.draft.organizationId !== context.organizationId)
    refuse("DEFINITION_ORGANIZATION_MISMATCH");
  if (
    String(candidate.draft.rootId) !== String(command.rootId) ||
    candidate.draft.draftRevision !== command.expectedDraftRevision
  )
    refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
  if (
    candidate.historyEvidence.kind !== candidate.draft.kind ||
    candidate.historyEvidence.definitionKey !== candidate.draft.key ||
    String(candidate.historyEvidence.rootId) !== String(candidate.draft.rootId)
  )
    refuse("DEFINITION_HISTORY_INVALID");
  const latest = candidate.historyEvidence.latestRelease;
  if (
    candidate.draft.publishedRevision !== latest?.publication.revision ||
    candidate.draft.sourceFingerprint !== fingerprintCanonicalValue(candidate.draft.source)
  )
    refuse(
      candidate.draft.sourceFingerprint !== fingerprintCanonicalValue(candidate.draft.source)
        ? "DEFINITION_SOURCE_EVIDENCE_MISMATCH"
        : "DEFINITION_HISTORY_INVALID",
    );
  return candidate;
};

/** The one explicit comparator contract each stored draft kind declares. */
const candidateValidationContractVersion = (
  source: StoredDefinitionDraft["source"],
): Readonly<{ validationContractVersion: "2.0.0" | "3.0.0" }> => ({
  validationContractVersion: source.kind === "module" ? "3.0.0" : "2.0.0",
});

const prepareFromReader = async (
  context: SessionContext,
  reader: DefinitionPublicationReader,
  catalogue: DefinitionPublicationCatalogue,
  command: PrepareDefinitionPublicationCommand,
  candidateInput: DefinitionPublicationCandidate | undefined,
  pinned?: readonly ExactDefinitionDependency[],
): Promise<PreparedState> => {
  const candidate = validateCandidate(context, candidateInput, command);
  const dependencies = await resolveDependencies(reader, catalogue, candidate, pinned);
  await assertNoCycle(reader, candidate, dependencies.modules);
  const provisionalVersion =
    candidate.historyEvidence.latestRelease?.publication.releaseVersion ?? "1.0.0";
  const provisionalResolution = buildResolution(candidate, dependencies, provisionalVersion);
  const provisional = compileCandidate(candidate, dependencies, provisionalResolution, false);
  const impact = compareDefinitionVersionImpactWithEvidence({
    kind: candidate.draft.kind,
    ...candidateValidationContractVersion(candidate.draft.source),
    historyEvidence: candidate.historyEvidence,
    candidate: provisional.canonical,
  });
  if (impact.outcome === "no_change") refuse("DEFINITION_NO_CHANGE");
  const confirmableImpact = impact as Extract<typeof impact, { assignedVersion: string }>;
  const resolution = buildResolution(candidate, dependencies, confirmableImpact.assignedVersion);
  const compilationOutput = compileCandidate(candidate, dependencies, resolution, true);
  const confirmedImpact = compareDefinitionVersionImpactWithEvidence({
    kind: candidate.draft.kind,
    ...candidateValidationContractVersion(candidate.draft.source),
    historyEvidence: candidate.historyEvidence,
    candidate: compilationOutput.canonical,
  });
  if (confirmedImpact.outcome === "no_change") refuse("DEFINITION_VERSION_REFUSED");
  const finalImpact = confirmedImpact as Extract<
    typeof confirmedImpact,
    { assignedVersion: string }
  >;
  if (
    finalImpact.assignedVersion !== confirmableImpact.assignedVersion
  )
    refuse("DEFINITION_VERSION_REFUSED");
  const confirmation = definitionPublicationConfirmationSchema.parse({
    outcome: finalImpact.outcome,
    rootId: candidate.draft.rootId,
    expectedDraftRevision: candidate.draft.draftRevision,
    sourceFingerprint: candidate.draft.sourceFingerprint,
    assignedVersion: finalImpact.assignedVersion,
    contentFingerprint: compilationOutput.artifact.contentFingerprint,
    resolutionFingerprint: compilationOutput.resolutionFingerprint,
    comparisonFingerprint: finalImpact.comparisonFingerprint,
    dependencyManifest: manifestFor(dependencies, compilationOutput),
    reasons: finalImpact.reasons,
    ...(finalImpact.outcome === "release_required" ? { impact: finalImpact.impact } : {}),
  });
  return {
    confirmation,
    draft: candidate.draft,
    compilationOutput,
    resolutionSnapshot: resolution,
  };
};

const safely = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DefinitionPublicationError) throw error;
    if (error instanceof DefinitionCompilationError) refuse("DEFINITION_COMPILATION_REFUSED");
    if (error instanceof DefinitionVersionImpactError) refuse("DEFINITION_VERSION_REFUSED");
    return refuse("DEFINITION_PUBLICATION_FAILED");
  }
};

/**
 * Publication orchestration over private injected stores. Preparation exposes only safe JSON
 * evidence; every byte that matters is recomputed inside the publish transaction.
 */
export const createDefinitionPublicationService = (
  repository: DefinitionPublicationRepository,
  catalogue: DefinitionPublicationCatalogue,
) => ({
  prepare: async (
    context: SessionContext,
    input: unknown,
  ): Promise<PreparedDefinitionPublication> => {
    const command = prepareDefinitionPublicationCommandSchema.safeParse(input);
    if (!command.success) refuse("INVALID_DEFINITION_PUBLICATION_COMMAND");
    const parsedCommand = command.data as PrepareDefinitionPublicationCommand;
    return safely(async () => {
      const state = await repository.read(context, async (reader) =>
        prepareFromReader(
          context,
          reader,
          catalogue,
          parsedCommand,
          await reader.readCandidate(parsedCommand.rootId),
        ),
      );
      return prepareDefinitionPublicationResultSchema.parse({
        confirmation: state.confirmation,
      });
    });
  },

  /**
   * Compiles the caller organisation's current Application draft at the expected revision through
   * the same candidate validation, exact dependency resolution and compilation as preparation. It
   * is a read for exact-draft preview (#597): it assigns no version, produces no confirmation and
   * writes nothing, and a draft identical to its current release still compiles.
   */
  compileApplicationDraft: async (
    context: SessionContext,
    input: unknown,
  ): Promise<ApplicationDraftCompilation> => {
    const command = prepareDefinitionPublicationCommandSchema.safeParse(input);
    if (!command.success) refuse("INVALID_DEFINITION_PUBLICATION_COMMAND");
    const parsedCommand = command.data as PrepareDefinitionPublicationCommand;
    return safely(async () =>
      repository.read(context, async (reader) => {
        const candidate = validateCandidate(
          context,
          await reader.readCandidate(parsedCommand.rootId),
          parsedCommand,
        );
        // Another definition kind at this root is refused exactly like a missing draft.
        if (candidate.draft.kind !== "application" || candidate.draft.source.kind !== "application")
          refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
        const dependencies = await resolveDependencies(reader, catalogue, candidate);
        await assertNoCycle(reader, candidate, dependencies.modules);
        const currentVersion =
          candidate.historyEvidence.latestRelease?.publication.releaseVersion ?? "1.0.0";
        const compilation = compileCandidate(
          candidate,
          dependencies,
          buildResolution(candidate, dependencies, currentVersion),
          false,
        );
        if (compilation.kind !== "application") return refuse("DEFINITION_COMPILATION_REFUSED");
        return {
          compilation,
          currentReleaseRevision: candidate.draft.publishedRevision ?? null,
        };
      }),
    );
  },

  publish: async (context: SessionContext, input: unknown): Promise<PublishDefinitionResult> => {
    const command = publishDefinitionCommandSchema.safeParse(input);
    if (!command.success) refuse("INVALID_DEFINITION_PUBLICATION_COMMAND");
    const parsedCommand = command.data as PublishDefinitionCommand;
    return safely(async () =>
      repository.transaction(context, async (transaction) => {
        const confirmation = parsedCommand.confirmation;
        const recomputed = await prepareFromReader(
          context,
          transaction,
          catalogue,
          {
            rootId: confirmation.rootId,
            expectedDraftRevision: confirmation.expectedDraftRevision,
          },
          await transaction.lockCandidate(confirmation.rootId),
          confirmation.dependencyManifest,
        );
        if (
          fingerprintCanonicalValue(recomputed.confirmation) !==
          fingerprintCanonicalValue(confirmation)
        )
          refuse("DEFINITION_CONFIRMATION_MISMATCH");
        const result = await transaction.appendRelease({
          draft: recomputed.draft,
          compilationOutput: recomputed.compilationOutput,
          assignedVersion: confirmation.assignedVersion,
          comparisonFingerprint: confirmation.comparisonFingerprint,
          reasons: confirmation.reasons,
          dependencyManifest: confirmation.dependencyManifest,
          resolutionSnapshot: recomputed.resolutionSnapshot,
          validationContractVersion: recomputed.draft.source.source_contract_version,
          releaseNote: parsedCommand.releaseNote,
        });
        const parsed = publishDefinitionResultSchema.safeParse(result);
        if (!parsed.success) refuse("DEFINITION_PUBLICATION_FAILED");
        const published = parsed.data as PublishDefinitionResult;
        if (
          published.rootId !== confirmation.rootId ||
          published.releaseRevision !== confirmation.expectedDraftRevision ||
          published.releaseVersion !== confirmation.assignedVersion ||
          published.contentFingerprint !== confirmation.contentFingerprint ||
          published.resolutionFingerprint !== confirmation.resolutionFingerprint ||
          published.comparisonFingerprint !== confirmation.comparisonFingerprint ||
          fingerprintCanonicalValue(published.dependencyManifest) !==
            fingerprintCanonicalValue(confirmation.dependencyManifest)
        )
          refuse("DEFINITION_PUBLICATION_FAILED");
        return published;
      }),
    );
  },
});
