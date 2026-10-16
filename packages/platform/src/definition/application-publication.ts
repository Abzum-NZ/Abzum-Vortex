import "server-only";

import {
  definitionPublicationConfirmationSchema,
  prepareDefinitionPublicationCommandSchema,
  type ExactDefinitionDependency,
  type PrepareDefinitionPublicationCommand,
  type PublishDefinitionResult,
  type SessionContext,
  type VersionImpact,
  type VersionImpactReason,
} from "../schema";
import { applicationValidationContractVersion } from "./application-contract-versions";
import { applicationModuleSources } from "./application-module-lowering";
import { canonicalJson, fingerprintCanonicalValue } from "./canonical-json-definition";
import {
  compileApplicationCandidate,
  compileCandidate,
  validateCandidate,
} from "./definition-publication-compilation";
import {
  type DefinitionCandidateDraft,
  type DefinitionDraftCandidate,
  type DefinitionPublicationCandidate,
  type DefinitionPublicationCatalogue,
  type DefinitionPublicationTransaction,
  type ModuleOutput,
  type OwnedModuleRoot,
  type PreparedState,
  type ResolvableModuleRelease,
  refuse,
} from "./definition-publication-contracts";
import {
  assertNoCycle,
  buildResolution,
  manifestFor,
  resolveDependencies,
  selectCurrentModuleRelease,
} from "./definition-dependency-resolution";
import { moduleDependencies } from "./module-dependencies";
import { assignNextDefinitionVersion } from "./semantic-version";
import { compareDefinitionVersionImpactWithEvidence } from "./version-impact-definition";

/**
 * One publication of an Application writes everything it owns in one transaction: the internal
 * release of every inline Module that changed, each at the Application's new version, and then
 * the Application's release pinning every Module release it was compiled against. People only
 * ever see Application versions; a Module release is an internal part of one.
 */

export type ApplicationPublicationState = PreparedState &
  Readonly<{ moduleOutputs: readonly ModuleOutput[] }>;

type ModuleStep = Readonly<{
  output: ModuleOutput;
  reasons: readonly VersionImpactReason[];
  release: PublishDefinitionResult;
}>;

/** Reads and checks the Application draft a publication is for; any other kind is refused. */
export const applicationCandidate = (
  context: SessionContext,
  candidate: DefinitionPublicationCandidate | undefined,
  command: PrepareDefinitionPublicationCommand,
): DefinitionPublicationCandidate => {
  const checked = validateCandidate(context, candidate, command);
  if (checked.draft.kind !== "application" || checked.draft.source.kind !== "application")
    return refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
  return checked;
};

const inlineModuleSources = (candidate: DefinitionCandidateDraft) =>
  candidate.draft.source.kind === "application"
    ? applicationModuleSources(candidate.draft.source)
    : refuse("DEFINITION_DRAFT_STALE_OR_MISSING");

/**
 * Writes the current lowering of each inline Module into the internal root the Application owns,
 * creating the roots that are missing. A Module whose source changed, or whose draft is already
 * released, gets a new draft revision so that this publication can release it. The writes record
 * the Module's permanent identities, which compilation needs, so they are kept even when a
 * preparation only rehearses the publication itself.
 */
export const materializeInlineModules = async (
  transaction: DefinitionPublicationTransaction,
  candidate: DefinitionCandidateDraft,
  unchanged: ReadonlySet<string> = new Set(),
): Promise<ReadonlyMap<string, OwnedModuleRoot>> => {
  const owned = new Map(
    (await transaction.readOwnedModuleRoots(String(candidate.draft.rootId))).map(
      (root) => [root.key, root] as const,
    ),
  );
  const roots = new Map<string, OwnedModuleRoot>();
  for (const source of inlineModuleSources(candidate)) {
    if (unchanged.has(source.key)) continue;
    const existing = owned.get(source.key);
    const root =
      existing === undefined
        ? await transaction.createOwnedModuleRoot(String(candidate.draft.rootId), source)
        : existing.sourceFingerprint !== fingerprintCanonicalValue(source) ||
            existing.draftRevision === existing.currentReleaseRevision
          ? await transaction.stageOwnedModuleSource(existing, source)
          : existing;
    roots.set(source.key, root);
  }
  return roots;
};

const highestImpact = (reasons: readonly VersionImpactReason[]): VersionImpact => {
  const ranks = { patch: 0, minor: 1, major: 2 } as const;
  return reasons.reduce<VersionImpact>(
    (highest, reason) => (ranks[reason.impact] > ranks[highest] ? reason.impact : highest),
    "patch",
  );
};

/**
 * Compiles every inline Module, in dependency order, against the current release of each Module
 * it depends on, and appends a release at `version` for each one that changed. A sibling released
 * earlier in the same pass is already the current release its dependants compile against.
 */
const releaseInlineModules = async (
  context: SessionContext,
  transaction: DefinitionPublicationTransaction,
  catalogue: DefinitionPublicationCatalogue,
  candidate: DefinitionCandidateDraft,
  roots: ReadonlyMap<string, OwnedModuleRoot>,
  version: string,
  releaseNote: string,
  unchanged: ReadonlySet<string> = new Set(),
): Promise<ModuleStep[]> => {
  const steps: ModuleStep[] = [];
  for (const source of inlineModuleSources(candidate)) {
    if (unchanged.has(source.key)) continue;
    const root = roots.get(source.key);
    if (root === undefined) return refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
    const module = validateCandidate(
      context,
      await transaction.readCandidate(root.rootId),
      prepareDefinitionPublicationCommandSchema.parse({
        rootId: root.rootId,
        expectedDraftRevision: root.draftRevision,
      }),
    );
    if (
      module.draft.kind !== "module" ||
      fingerprintCanonicalValue(module.draft.source) !== fingerprintCanonicalValue(source)
    )
      return refuse("DEFINITION_SOURCE_EVIDENCE_MISMATCH");
    const dependencies = await resolveDependencies(transaction, catalogue, module);
    await assertNoCycle(transaction, module, dependencies.modules);
    const resolution = buildResolution(module, dependencies, version);
    const draftOutput = compileCandidate(
      module,
      dependencies,
      resolution,
      false,
      catalogue.permissions,
    );
    const impact = compareDefinitionVersionImpactWithEvidence({
      kind: "module",
      validationContractVersion: "3.0.0",
      historyEvidence: module.historyEvidence,
      candidate: draftOutput.canonical,
    });
    // A Module is released again when a Module it depends on was, even with no change of its own,
    // so every release in one Application pins each Module at exactly one release.
    const latest = module.historyEvidence.latestRelease as {
      dependencyManifest?: readonly { kind: string; rootId?: unknown; revision?: unknown }[];
    } | null;
    const latestPins = new Set(
      (latest?.dependencyManifest ?? [])
        .filter((dependency) => dependency.kind === "module")
        .map(
          (dependency) =>
            `${String(dependency.rootId).toLowerCase()}:${String(dependency.revision)}`,
        ),
    );
    const pins = dependencies.modules.map(
      (release) => `${String(release.rootId).toLowerCase()}:${String(release.releaseRevision)}`,
    );
    const repinned =
      latest !== null &&
      (pins.length !== latestPins.size || pins.some((pin) => !latestPins.has(pin)));
    if (impact.outcome === "no_change" && !repinned) continue;
    const reasons = impact.outcome === "no_change" ? [] : impact.reasons;
    const output = compileCandidate(module, dependencies, resolution, true, catalogue.permissions);
    if (output.kind !== "module") return refuse("DEFINITION_COMPILATION_REFUSED");
    const release = await transaction.appendModuleRelease({
      draft: module.draft,
      compilationOutput: output,
      assignedVersion: version,
      reasons,
      dependencyManifest: manifestFor(dependencies, output, resolution),
      resolutionSnapshot: resolution,
      validationContractVersion: "3.0.0",
      releaseNote,
    });
    steps.push({ output, reasons, release });
  }
  return steps;
};

/** The Application compiled at `version` against the current release of every Module it names. */
const compileApplication = async (
  transaction: DefinitionPublicationTransaction,
  catalogue: DefinitionPublicationCatalogue,
  candidate: DefinitionPublicationCandidate,
  version: string,
  final: boolean,
  pinned?: readonly ExactDefinitionDependency[],
) => {
  const dependencies = await resolveDependencies(transaction, catalogue, candidate, pinned);
  await assertNoCycle(transaction, candidate, dependencies.modules);
  const resolution = buildResolution(candidate, dependencies, version);
  const output = compileCandidate(
    candidate,
    dependencies,
    resolution,
    final,
    catalogue.permissions,
  );
  if (output.kind !== "application") return refuse("DEFINITION_COMPILATION_REFUSED");
  return {
    output,
    resolution,
    dependencies,
    manifest: manifestFor(dependencies, output, resolution),
  };
};

type CompiledApplication = Awaited<ReturnType<typeof compileApplication>>;

type ModuleBinding = Readonly<{ moduleRootId: string; resolvedVersion: string }>;

/**
 * The one set of reasons the Application's new version answers: its own changes, the changes of
 * each inline Module it releases, and each used Module whose owner has released it since.
 */
const publicationReasons = (
  candidate: DefinitionPublicationCandidate,
  roots: ReadonlyMap<string, OwnedModuleRoot>,
  modules: readonly ModuleStep[],
  application: CompiledApplication,
): VersionImpactReason[] => {
  const latest = candidate.historyEvidence.latestRelease;
  if (latest === null) return [];
  const own = compareDefinitionVersionImpactWithEvidence({
    kind: "application",
    validationContractVersion: applicationValidationContractVersion,
    historyEvidence: candidate.historyEvidence,
    candidate: application.output.canonical,
  });
  const ownedRootIds = new Set([...roots.values()].map((root) => String(root.rootId)));
  const previousBindings = new Map(
    ((latest.content as { moduleBindings?: ModuleBinding[] }).moduleBindings ?? []).map(
      (binding) => [String(binding.moduleRootId), binding.resolvedVersion] as const,
    ),
  );
  const usedChanges: VersionImpactReason[] = (
    application.output.canonical.content.moduleBindings as readonly ModuleBinding[]
  ).flatMap((binding) => {
    const previous = previousBindings.get(String(binding.moduleRootId));
    return ownedRootIds.has(String(binding.moduleRootId)) ||
      previous === undefined ||
      previous === binding.resolvedVersion
      ? []
      : [
          {
            impact: "minor" as const,
            code: "dependency_requirement_changed" as const,
            location: {
              componentKind: "module_binding" as const,
              componentId: binding.moduleRootId as VersionImpactReason["location"]["componentId"],
              property: "version_requirement" as const,
            },
          },
        ];
  });
  return [
    ...(own.outcome === "release_required" ? own.reasons : []),
    ...modules.flatMap((module) => module.reasons),
    ...usedChanges,
  ].sort((left, right) => (canonicalJson(left) < canonicalJson(right) ? -1 : 1));
};

/**
 * Releases the inline Modules and compiles the Application exactly as its publication will. The
 * version depends on what changed, and what changed is the same at every version, so a rehearsal
 * at a provisional version (rolled back) finds the reasons and then the real pass runs at the
 * version they assign. The caller appends the Application release, or rehearses this whole step.
 */
export const planApplicationPublication = async (
  context: SessionContext,
  transaction: DefinitionPublicationTransaction,
  catalogue: DefinitionPublicationCatalogue,
  candidate: DefinitionPublicationCandidate,
  roots: ReadonlyMap<string, OwnedModuleRoot>,
  releaseNote: string,
  pinned?: readonly ExactDefinitionDependency[],
): Promise<ApplicationPublicationState> => {
  const latestVersion = candidate.historyEvidence.latestRelease?.publication.releaseVersion;
  const provisional =
    latestVersion === undefined ? "1.0.0" : assignNextDefinitionVersion(latestVersion, "major");
  const pass = async (version: string, final: boolean, pins?: typeof pinned) => {
    const modules = await releaseInlineModules(
      context,
      transaction,
      catalogue,
      candidate,
      roots,
      version,
      releaseNote,
    );
    const application = await compileApplication(
      transaction,
      catalogue,
      candidate,
      version,
      final,
      pins,
    );
    return {
      modules,
      application,
      reasons: publicationReasons(candidate, roots, modules, application),
    };
  };
  const rehearsed = await transaction.rehearse(
    async () => (await pass(provisional, false)).reasons,
  );
  if (latestVersion !== undefined && rehearsed.length === 0) refuse("DEFINITION_NO_CHANGE");
  const version =
    latestVersion === undefined
      ? "1.0.0"
      : assignNextDefinitionVersion(latestVersion, highestImpact(rehearsed));
  const { modules, application, reasons } = await pass(version, true, pinned);
  if (canonicalJson(reasons) !== canonicalJson(rehearsed)) refuse("DEFINITION_VERSION_REFUSED");
  const confirmation = definitionPublicationConfirmationSchema.parse({
    outcome: latestVersion === undefined ? "initial_release" : "release_required",
    rootId: candidate.draft.rootId,
    expectedDraftRevision: candidate.draft.draftRevision,
    sourceFingerprint: candidate.draft.sourceFingerprint,
    assignedVersion: version,
    contentFingerprint: application.output.artifact.contentFingerprint,
    resolutionFingerprint: application.output.resolutionFingerprint,
    dependencyManifest: application.manifest,
    reasons,
    ...(latestVersion === undefined ? {} : { impact: highestImpact(reasons) }),
  });
  return {
    confirmation,
    draft: candidate.draft,
    compilationOutput: application.output,
    resolutionSnapshot: application.resolution,
    moduleOutputs: modules.map((module) => module.output),
  };
};

/** The internal releases a preview rehearsal writes are undone; the note only labels them. */
const previewReleaseNote = "Rehearsed for a preview";

/** One release a preview runs: its stored row and dependency rows, read back as JSON. */
export type RehearsedPreviewRelease = Readonly<{ release: unknown; dependencies: unknown }>;

/**
 * The draft exactly as its publication would release it: every inline Module that changed and
 * then the Application are compiled and appended through the publication path, read back as the
 * stored rows, and the whole rehearsal is undone. Nothing is released; a preview runs these rows.
 * A draft identical to its current release rehearses nothing and previews that release.
 */
export const rehearseApplicationPreview = async (
  context: SessionContext,
  transaction: DefinitionPublicationTransaction,
  catalogue: DefinitionPublicationCatalogue,
  candidate: DefinitionPublicationCandidate,
  roots: ReadonlyMap<string, OwnedModuleRoot>,
): Promise<readonly RehearsedPreviewRelease[]> => {
  const latestVersion = candidate.historyEvidence.latestRelease?.publication.releaseVersion;
  const version =
    latestVersion === undefined ? "1.0.0" : assignNextDefinitionVersion(latestVersion, "major");
  return transaction.rehearse(async () => {
    const modules = await releaseInlineModules(
      context,
      transaction,
      catalogue,
      candidate,
      roots,
      version,
      previewReleaseNote,
    );
    const pins = modules.map((module) => ({
      rootId: String(module.release.rootId),
      releaseRevision: module.release.releaseRevision,
    }));
    if (candidate.draft.publishedRevision !== candidate.draft.draftRevision) {
      const application = await compileApplication(transaction, catalogue, candidate, version, true);
      const release = await transaction.appendRelease({
        draft: candidate.draft,
        compilationOutput: application.output,
        assignedVersion: version,
        reasons: publicationReasons(candidate, roots, modules, application),
        dependencyManifest: application.manifest,
        resolutionSnapshot: application.resolution,
        validationContractVersion: applicationValidationContractVersion,
        releaseNote: previewReleaseNote,
      });
      pins.push({ rootId: String(release.rootId), releaseRevision: release.releaseRevision });
    }
    return transaction.readRehearsedReleases(String(candidate.draft.rootId), pins);
  });
};

/**
 * The inline Modules whose current release already is what their publication would leave current.
 * A Module qualifies when its draft is exactly its released source, every sibling it depends on
 * qualifies, and its release pins exactly the releases its dependencies resolve to now. Its
 * publication would compile it, find no change and no new pin, and not release it, so a draft
 * compile takes the release as it is instead of compiling it again.
 */
const releasedUnchangedModules = async (
  transaction: DefinitionPublicationTransaction,
  candidate: DefinitionCandidateDraft,
): Promise<ReadonlySet<string>> => {
  const owned = new Map(
    (await transaction.readOwnedModuleRoots(String(candidate.draft.rootId))).map(
      (root) => [root.key, root] as const,
    ),
  );
  const sources = inlineModuleSources(candidate);
  const inlineKeys = new Set(sources.map((source) => source.key));
  const usedReleases = new Map<string, ResolvableModuleRelease>();
  const unchanged = new Set<string>();
  for (const source of sources) {
    const root = owned.get(source.key);
    if (
      root === undefined ||
      root.currentReleaseRevision === null ||
      root.draftRevision !== root.currentReleaseRevision ||
      root.sourceFingerprint !== fingerprintCanonicalValue(source)
    )
      continue;
    const dependencies = moduleDependencies(source).map((dependency) => dependency.module);
    if (dependencies.some((key) => inlineKeys.has(key) && !unchanged.has(key))) continue;
    const release = await transaction.readModuleRelease(
      candidate.draft.organizationId,
      root.rootId,
      root.currentReleaseRevision,
    );
    if (release === undefined) continue;
    const pinned = new Set(
      release.published.dependencyManifest.map((dependency) =>
        dependency.kind === "module"
          ? `${String(dependency.rootId).toLowerCase()}:${String(dependency.revision)}`
          : dependency.kind,
      ),
    );
    const expected: string[] = [];
    for (const key of dependencies) {
      const sibling = owned.get(key);
      if (inlineKeys.has(key)) {
        expected.push(
          `${String(sibling?.rootId).toLowerCase()}:${String(sibling?.currentReleaseRevision)}`,
        );
        continue;
      }
      let used = usedReleases.get(key);
      if (used === undefined) {
        used = await selectCurrentModuleRelease(transaction, candidate, key);
        usedReleases.set(key, used);
      }
      expected.push(`${String(used.rootId).toLowerCase()}:${String(used.releaseRevision)}`);
    }
    if (pinned.size === expected.length && expected.every((pin) => pinned.has(pin)))
      unchanged.add(source.key);
  }
  return unchanged;
};

/** The inline Module releases a draft compile holds in memory are never stored; the note only labels them. */
const draftCompileReleaseNote = "Compiled for the draft";

/**
 * The Application draft compiled with its own inline Modules, exactly as its publication
 * compiles them: each inline Module is staged, compiled and released through the publication's
 * own steps, and the Application is compiled against those releases. Run against the in-memory
 * publication transaction it writes nothing, so Studio compiles a draft whose Modules add
 * fields, record types or queries that no installed release has yet.
 */
export const compileApplicationWithInlineModules = async (
  context: SessionContext,
  transaction: DefinitionPublicationTransaction,
  catalogue: DefinitionPublicationCatalogue,
  candidate: DefinitionDraftCandidate,
) => {
  const unchanged = await releasedUnchangedModules(transaction, candidate);
  const roots = await materializeInlineModules(transaction, candidate, unchanged);
  const version =
    candidate.currentReleaseVersion === null
      ? "1.0.0"
      : assignNextDefinitionVersion(candidate.currentReleaseVersion, "major");
  await releaseInlineModules(
    context,
    transaction,
    catalogue,
    candidate,
    roots,
    version,
    draftCompileReleaseNote,
    unchanged,
  );
  const dependencies = await resolveDependencies(transaction, catalogue, candidate);
  await assertNoCycle(transaction, candidate, dependencies.modules);
  const resolution = buildResolution(candidate, dependencies, version);
  const { output } = compileApplicationCandidate(
    candidate,
    dependencies,
    resolution,
    catalogue.permissions,
  );
  return { output, resolution, dependencies };
};
