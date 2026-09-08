import "server-only";

import {
  applicationCompositionCatalogueSnapshotV2Schema,
  definitionCompilationOutputSchema,
  definitionPublicationConfirmationSchema,
  definitionResolutionSnapshotSchema,
  prepareDefinitionPublicationCommandSchema,
  prepareDefinitionPublicationResultSchema,
  publishDefinitionCommandSchema,
  publishDefinitionResultSchema,
  publishedDefinitionHistorySchema,
  savedConditionRevisionAssignmentSchema,
  stableDefinitionReleaseVersionSchema,
  storedDefinitionDraftSchema,
  type DefinitionCompilationOutput,
  type DefinitionPublicationConfirmation,
  type DefinitionResolutionSnapshot,
  type DefinitionResolutionSnapshotV2,
  type ApplicationCompositionCatalogueSnapshotV2,
  type ApplicationSourceDocumentV2,
  type BlockId,
  type ExactDefinitionDependency,
  type PrepareDefinitionPublicationCommand,
  type PrepareDefinitionPublicationResult,
  type PublishDefinitionCommand,
  type PublishedDefinitionHistory,
  type PublishedModuleDefinition,
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
  type Revision,
  type SemanticVersion,
} from "@vortex/contracts";
import { compare, satisfies } from "semver";
import { compareCanonicalStrings, fingerprintCanonicalValue } from "./canonical-json";
import { createApplicationResolutionSnapshotV2 } from "./application-v2-resolution";
import { compileDefinition, compileDefinitionWithContext } from "./compiler";
import { DefinitionCompilationError } from "./compilation-error";
import { deriveSavedConditionRevisions } from "./saved-condition-revisions";
import { compileDefinitionSet, validateDefinitionSet } from "./validation";
import { compareDefinitionVersionImpact } from "./version-impact";
import { DefinitionVersionImpactError } from "./version-impact-error";

type SourceIdentityAssignments = DefinitionResolutionSnapshotV2["identities"];
type ModuleOutput = Extract<DefinitionCompilationOutput, { kind: "module" }>;
type ConnectionOutput = Extract<DefinitionCompilationOutput, { kind: "connection_type" }>;
type DefinitionResolution = DefinitionResolutionSnapshot | DefinitionResolutionSnapshotV2;

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
export type DefinitionPublicationCandidate = Readonly<{
  draft: StoredDefinitionDraft;
  identities: SourceIdentityAssignments;
  history: PublishedDefinitionHistory;
}>;

/** Immutable organization-owned module release made available to a dependency compilation. */
export type ResolvableModuleRelease = Readonly<{
  organizationId: OrganizationId;
  key: string;
  rootId: ModuleRootId;
  releaseRevision: Revision;
  releaseVersion: SemanticVersion;
  contentFingerprint: Fingerprint;
  resolutionFingerprint: Fingerprint;
  published: PublishedModuleDefinition;
  compilationOutput: ModuleOutput;
  resolutionSnapshot: DefinitionResolutionSnapshot;
}>;

export type ResolvableConnectionTypeRelease = Readonly<{
  key: string;
  rootId: ConnectionTypeId;
  releaseVersion: SemanticVersion;
  contentFingerprint: Fingerprint;
  catalogueFingerprint: Fingerprint;
  compilationOutput: ConnectionOutput;
}>;

export type ResolvablePlatformThemeRelease = Readonly<{
  catalogueThemeId: string;
  releaseVersion: SemanticVersion;
  contentFingerprint: Fingerprint;
  catalogueFingerprint: Fingerprint;
}>;

export interface DefinitionPublicationReader {
  readCandidate(rootId: string): Promise<DefinitionPublicationCandidate | undefined>;
  listModuleReleases(
    organizationId: OrganizationId,
    key: string,
  ): Promise<readonly ResolvableModuleRelease[]>;
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
  readPlatformThemeRelease(
    catalogueThemeId: string,
    releaseVersion: string,
  ): Promise<ResolvablePlatformThemeRelease | undefined>;
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
}

export type DefinitionReleaseAppend = Readonly<{
  draft: StoredDefinitionDraft;
  compilationOutput: Exclude<DefinitionCompilationOutput, { kind: "connection_type" }>;
  assignedVersion: string;
  comparisonFingerprint: string;
  reasons: DefinitionPublicationConfirmation["reasons"];
  dependencyManifest: readonly ExactDefinitionDependency[];
  resolutionSnapshot: DefinitionResolution;
  validationContractVersion: "1.0.0" | "2.0.0";
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

type Requirement = Readonly<{ key: string; version: VersionRequirement }>;

type ResolvedDependencies = Readonly<{
  modules: readonly ResolvableModuleRelease[];
  connections: readonly ResolvableConnectionTypeRelease[];
  theme?: ResolvablePlatformThemeRelease;
  compositionV2?: ApplicationCompositionCatalogueSnapshotV2;
}>;

const stable = (version: string): boolean =>
  stableDefinitionReleaseVersionSchema.safeParse(version).success;

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
      : `${dependency.kind}:${dependency.key}`;

const sortedManifest = (
  dependencies: readonly ExactDefinitionDependency[],
): ExactDefinitionDependency[] =>
  [...dependencies].sort((left, right) =>
    compareCanonicalStrings(subjectOf(left), subjectOf(right)),
  );

const verifyModuleRelease = (
  candidate: DefinitionPublicationCandidate,
  expectedKey: string,
  release: ResolvableModuleRelease,
): void => {
  const parsedOutput = definitionCompilationOutputSchema.safeParse(release.compilationOutput);
  const parsedResolution = definitionResolutionSnapshotSchema.safeParse(release.resolutionSnapshot);
  const publication = release.published.publication;
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
    !stable(release.releaseVersion) ||
    !parsedOutput.success ||
    parsedOutput.data.kind !== "module" ||
    !parsedResolution.success ||
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
  candidate: DefinitionPublicationCandidate,
  pinned?: readonly ExactDefinitionDependency[],
): Promise<ResolvedDependencies> => {
  const modules: ResolvableModuleRelease[] = [];
  for (const [key, requirements] of groupRequirements(moduleRequirements(candidate.draft))) {
    let release: ResolvableModuleRelease | undefined;
    if (pinned === undefined) {
      release = chooseStableRelease(
        await reader.listModuleReleases(candidate.draft.organizationId, key),
        requirements,
      );
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

  let theme: ResolvablePlatformThemeRelease | undefined;
  let compositionV2: ApplicationCompositionCatalogueSnapshotV2 | undefined;
  if (
    candidate.draft.source.kind === "application" &&
    candidate.draft.source.source_contract_version === "1.0.0" &&
    candidate.draft.source.body.theme.mode === "platform"
  ) {
    const requested = candidate.draft.source.body.theme;
    const exact =
      pinned === undefined
        ? undefined
        : findPinned(pinned, "platform_theme", requested.catalogue_theme_id);
    if (exact !== undefined && exact.releaseVersion !== requested.version)
      refuse("DEFINITION_CONFIRMATION_MISMATCH");
    theme = await catalogue.readPlatformThemeRelease(
      requested.catalogue_theme_id,
      requested.version,
    );
    if (theme === undefined) refuse("DEFINITION_DEPENDENCY_MISSING");
    const resolvedTheme = theme as ResolvablePlatformThemeRelease;
    if (
      resolvedTheme.catalogueThemeId !== requested.catalogue_theme_id ||
      resolvedTheme.releaseVersion !== requested.version ||
      !stable(resolvedTheme.releaseVersion) ||
      (exact !== undefined &&
        (resolvedTheme.contentFingerprint !== exact.contentFingerprint ||
          resolvedTheme.catalogueFingerprint !== exact.catalogueFingerprint))
    )
      refuse("DEFINITION_DEPENDENCY_SUBSTITUTED");
    theme = resolvedTheme;
  }
  if (
    candidate.draft.source.kind === "application" &&
    candidate.draft.source.source_contract_version === "2.0.0"
  )
    compositionV2 = await resolveApplicationCompositionV2(
      candidate.draft.source,
      catalogue,
      pinned,
    );

  const expectedSubjects = [
    ...modules.map((release) => `module:${release.key}`),
    ...connections.map((release) => `connection_type:${release.key}`),
    ...(theme === undefined ? [] : [`platform_theme:${theme.catalogueThemeId}`]),
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
    JSON.stringify([...pinned].map(subjectOf).sort(compareCanonicalStrings)) !==
      JSON.stringify(expectedSubjects)
  )
    refuse("DEFINITION_CONFIRMATION_MISMATCH");
  return {
    modules,
    connections,
    ...(theme === undefined ? {} : { theme }),
    ...(compositionV2 === undefined ? {} : { compositionV2 }),
  };
};

const assertNoCycle = async (
  reader: DefinitionPublicationReader,
  candidate: DefinitionPublicationCandidate,
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

const manifestFor = (dependencies: ResolvedDependencies): ExactDefinitionDependency[] =>
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
    ...(dependencies.theme === undefined
      ? []
      : [
          {
            kind: "platform_theme" as const,
            catalogueThemeId: dependencies.theme.catalogueThemeId,
            releaseVersion: dependencies.theme.releaseVersion,
            contentFingerprint: dependencies.theme.contentFingerprint,
            catalogueFingerprint: dependencies.theme.catalogueFingerprint,
          },
        ]),
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
  ]);

const buildResolution = (
  candidate: DefinitionPublicationCandidate,
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
  const identities = [
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
  const evidence = { contractVersion: "1.0.0" as const, definitions, identities };
  if (
    candidate.draft.source.kind === "application" &&
    candidate.draft.source.source_contract_version === "2.0.0"
  )
    return createApplicationResolutionSnapshotV2({ definitions, identities });
  return definitionResolutionSnapshotSchema.parse({
    ...evidence,
    fingerprint: fingerprintCanonicalValue(evidence),
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
  candidate: DefinitionPublicationCandidate,
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

const compileCandidate = (
  candidate: DefinitionPublicationCandidate,
  dependencies: ResolvedDependencies,
  resolution: DefinitionResolution,
  final: boolean,
): Exclude<DefinitionCompilationOutput, { kind: "connection_type" }> => {
  const dependencyOutputs = [
    ...dependencies.modules.map((release) => release.compilationOutput),
    ...dependencies.connections.map((release) => release.compilationOutput),
  ].map((output) =>
    definitionCompilationOutputSchema.parse({
      ...output,
      artifact: { ...output.artifact, resolutionFingerprint: resolution.fingerprint },
      resolutionFingerprint: resolution.fingerprint,
    }),
  );
  if (
    candidate.draft.source.kind === "application" &&
    candidate.draft.source.source_contract_version === "2.0.0"
  ) {
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
    const output = compileDefinitionWithContext(request, { dependencyOutputs });
    if (final) {
      const validation = validateDefinitionSet({
        requests: [request],
        outputs: [output],
        dependencyOutputs,
        publishedHistories: [candidate.history],
      });
      if (!validation.valid) {
        const first = validation.failures[0]!;
        throw new DefinitionCompilationError(first.ruleCode, first.family, first.location);
      }
    }
    return output;
  }
  if (resolution.contractVersion !== "1.0.0") return refuse("DEFINITION_COMPILATION_REFUSED");
  const source = candidate.draft.source;
  if (source.kind === "application" && source.source_contract_version !== "1.0.0")
    return refuse("DEFINITION_COMPILATION_REFUSED");
  const common = {
    source,
    resolution,
    draftMetadata: draftMetadata(candidate.draft),
  };
  let savedConditionRevisions: SavedConditionRevisionAssignment[] | undefined;
  if (candidate.draft.kind === "module") {
    const provisional = compileDefinition({
      ...common,
      savedConditionRevisions: provisionalSavedConditionRevisions(candidate),
    });
    if (provisional.kind !== "module") refuse("DEFINITION_COMPILATION_REFUSED");
    const moduleOutput = provisional as ModuleOutput;
    if (candidate.history.kind !== "module") refuse("DEFINITION_HISTORY_INVALID");
    savedConditionRevisions = deriveSavedConditionRevisions({
      rootId: candidate.draft.rootId,
      conditions: moduleOutput.canonical.content.sharingConditions,
      history: candidate.history.kind === "module" ? candidate.history.history : [],
    });
  }
  const request = {
    ...common,
    ...(savedConditionRevisions === undefined ? {} : { savedConditionRevisions }),
  };
  if (!final) {
    const output = compileDefinitionWithContext(request, { dependencyOutputs });
    if (output.kind === "connection_type") refuse("DEFINITION_COMPILATION_REFUSED");
    return output as Exclude<DefinitionCompilationOutput, { kind: "connection_type" }>;
  }
  const outputs = compileDefinitionSet([request], {
    dependencyOutputs,
    publishedHistories: [candidate.history],
  });
  const output = outputs[0];
  if (output === undefined || output.kind === "connection_type")
    refuse("DEFINITION_COMPILATION_REFUSED");
  return output as Exclude<DefinitionCompilationOutput, { kind: "connection_type" }>;
};

const validateCandidate = (
  context: SessionContext,
  candidateInput: DefinitionPublicationCandidate | undefined,
  command: PrepareDefinitionPublicationCommand,
): DefinitionPublicationCandidate => {
  if (candidateInput === undefined) refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
  const supplied = candidateInput as DefinitionPublicationCandidate;
  const draft = storedDefinitionDraftSchema.safeParse(supplied.draft);
  const history = publishedDefinitionHistorySchema.safeParse(supplied.history);
  if (!draft.success || !history.success) refuse("DEFINITION_HISTORY_INVALID");
  const candidate: DefinitionPublicationCandidate = {
    draft: draft.success ? draft.data : supplied.draft,
    identities: supplied.identities,
    history: history.success ? history.data : supplied.history,
  };
  if (candidate.draft.organizationId !== context.organizationId)
    refuse("DEFINITION_ORGANIZATION_MISMATCH");
  if (
    String(candidate.draft.rootId) !== String(command.rootId) ||
    candidate.draft.draftRevision !== command.expectedDraftRevision
  )
    refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
  if (
    candidate.history.kind !== candidate.draft.kind ||
    candidate.history.definitionKey !== candidate.draft.key
  )
    refuse("DEFINITION_HISTORY_INVALID");
  const latest = candidate.history.history.at(-1);
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
    candidate.history.history.at(-1)?.publication.releaseVersion ?? "1.0.0";
  const provisionalResolution = buildResolution(candidate, dependencies, provisionalVersion);
  const provisional = compileCandidate(candidate, dependencies, provisionalResolution, false);
  const impact = compareDefinitionVersionImpact({
    kind: candidate.draft.kind,
    ...(candidate.draft.source.kind === "application" &&
    candidate.draft.source.source_contract_version === "2.0.0"
      ? { validationContractVersion: "2.0.0" as const }
      : {}),
    history: candidate.history.history,
    candidate: provisional.canonical,
  });
  if (impact.outcome === "no_change") refuse("DEFINITION_NO_CHANGE");
  const confirmableImpact = impact as Extract<typeof impact, { assignedVersion: string }>;
  const resolution = buildResolution(candidate, dependencies, confirmableImpact.assignedVersion);
  const compilationOutput = compileCandidate(candidate, dependencies, resolution, true);
  const confirmedImpact = compareDefinitionVersionImpact({
    kind: candidate.draft.kind,
    ...(candidate.draft.source.kind === "application" &&
    candidate.draft.source.source_contract_version === "2.0.0"
      ? { validationContractVersion: "2.0.0" as const }
      : {}),
    history: candidate.history.history,
    candidate: compilationOutput.canonical,
  });
  if (confirmedImpact.outcome === "no_change") refuse("DEFINITION_VERSION_REFUSED");
  const finalImpact = confirmedImpact as Extract<
    typeof confirmedImpact,
    { assignedVersion: string }
  >;
  if (
    finalImpact.assignedVersion !== confirmableImpact.assignedVersion ||
    finalImpact.comparisonFingerprint !== confirmableImpact.comparisonFingerprint
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
    dependencyManifest: manifestFor(dependencies),
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
          validationContractVersion:
            recomputed.draft.source.kind === "application"
              ? recomputed.draft.source.source_contract_version
              : "1.0.0",
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
