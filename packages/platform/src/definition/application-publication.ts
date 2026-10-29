import "server-only";

import type { SessionContext } from "../access/identity-access";
import {
  definitionPublicationConfirmationSchema,
  prepareDefinitionPublicationCommandSchema,
  type ExactDefinitionDependency,
  type PrepareDefinitionPublicationCommand,
} from "./definition-store-contracts";
import { definitionContractChangedReason } from "./version-impact";
import type { VersionImpact, VersionImpactReason } from "./version-impact";
import { applicationValidationContractVersion } from "./application-contract-versions";
import type { ModuleSourceDocument } from "./module-source-contracts";
import { applicationModuleSources } from "./application-module-lowering";
import { readRetainedApplicationModule } from "./application-draft-compilation-cache";
import { canonicalJson, fingerprintCanonicalValue } from "./canonical-json-definition";
import { platformPins } from "./platform-pins";
import {
  assertReleasable,
  compileApplicationCandidate,
  compileModuleCandidate,
  validateCandidate,
} from "./definition-publication-compilation";
import {
  type DefinitionCandidateDraft,
  type DefinitionDraftCandidate,
  type DefinitionPublicationCandidate,
  type DefinitionPublicationCatalogue,
  type DefinitionPublicationTransaction,
  type DefinitionPublicationReader,
  type DefinitionReleaseAppend,
  type ModuleOutput,
  type OwnedModuleRoot,
  type PreparedState,
  refuse,
} from "./definition-publication-contracts";
import {
  assertNoCycle,
  buildResolution,
  manifestFor,
  resolveDependencies,
  selectCurrentModuleRelease,
  type ResolvedDependencies,
} from "./definition-dependency-resolution";
import { createDraftModuleOverlay } from "./publication/draft-module-overlay";
import { derivedOwnedModuleRootId } from "./derived-definition-id";
import { moduleDependencies } from "./module-dependencies";
import { assignNextDefinitionVersion } from "./semantic-version";
import { compareDefinitionVersionImpactWithEvidence } from "./version-impact-definition";

/**
 * One publication of an Application writes everything it owns in one transaction: the internal
 * release of every inline Module that changed, each at the Application's new version, and then
 * the Application's release pinning every Module release it was compiled against. People only
 * ever see Application versions; a Module release is an internal part of one.
 */

type ApplicationPublicationState = PreparedState &
  Readonly<{
    moduleOutputs: readonly ModuleOutput[];
    moduleReleases: readonly DefinitionReleaseAppend[];
  }>;

type ModuleStep = Readonly<{
  output: ModuleOutput;
  reasons: readonly VersionImpactReason[];
  append: DefinitionReleaseAppend;
  dependencies: ResolvedDependencies;
  released: boolean;
  candidate: DefinitionPublicationCandidate;
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

// One compile asks for the inline Module sources of the same draft source from several steps
// (retention key, unchanged check, staging, release). Lowering parses every one against its
// contract and is a pure function of the source object, so each source object is lowered once and
// each lowered source is fingerprinted once; nothing outlives the objects it is keyed by.
const loweredModuleSources = new WeakMap<object, readonly ModuleSourceDocument[]>();
const moduleSourceFingerprints = new WeakMap<
  ModuleSourceDocument,
  ReturnType<typeof fingerprintCanonicalValue>
>();

const inlineModuleSources = (candidate: DefinitionCandidateDraft) => {
  const source = candidate.draft.source;
  if (source.kind !== "application") return refuse("DEFINITION_DRAFT_STALE_OR_MISSING");
  let lowered = loweredModuleSources.get(source);
  if (lowered === undefined) {
    lowered = applicationModuleSources(source);
    loweredModuleSources.set(source, lowered);
  }
  return lowered;
};

const moduleSourceFingerprint = (
  source: ModuleSourceDocument,
): ReturnType<typeof fingerprintCanonicalValue> => {
  let fingerprint = moduleSourceFingerprints.get(source);
  if (fingerprint === undefined) {
    fingerprint = fingerprintCanonicalValue(source);
    moduleSourceFingerprints.set(source, fingerprint);
  }
  return fingerprint;
};

/** The release version a draft or publication candidate was last released at, if any. */
export const latestReleaseVersion = (
  candidate: DefinitionDraftCandidate | DefinitionPublicationCandidate,
): string | null =>
  "currentReleaseVersion" in candidate
    ? candidate.currentReleaseVersion
    : (candidate.releaseHistory.latestRelease?.publication.releaseVersion ??
      candidate.releaseHistory.supersededReleaseVersion);

/**
 * Whether staging gives a stored inline Module root a new draft revision: its source changed, or
 * its draft is already released.
 */
const stagesOwnedModule = (existing: OwnedModuleRoot, sourceFingerprint: string): boolean =>
  existing.sourceFingerprint !== sourceFingerprint ||
  existing.draftRevision === existing.currentReleaseRevision;

/**
 * Writes the current lowering of each inline Module into the internal root the Application owns,
 * creating the roots that are missing. A Module whose source changed, or whose draft is already
 * released, gets a new draft revision so that this publication can release it. The writes record
 * the Module's permanent identities, which compilation needs, so they are kept even when a
 * preparation only plans the publication itself.
 */
export const materializeInlineModules = async (
  transaction: DefinitionPublicationTransaction,
  candidate: DefinitionCandidateDraft,
  ownedRoots: readonly OwnedModuleRoot[],
  unchanged: ReadonlySet<string> = new Set(),
): Promise<ReadonlyMap<string, OwnedModuleRoot>> => {
  const owned = new Map(ownedRoots.map((root) => [root.key, root] as const));
  const roots = new Map<string, OwnedModuleRoot>();
  for (const source of inlineModuleSources(candidate)) {
    if (unchanged.has(source.key)) continue;
    const existing = owned.get(source.key);
    const root =
      existing === undefined
        ? await transaction.createOwnedModuleRoot(String(candidate.draft.rootId), source)
        : stagesOwnedModule(existing, moduleSourceFingerprint(source))
          ? await transaction.stageOwnedModuleSource(existing, source)
          : existing;
    roots.set(source.key, root);
  }
  return roots;
};

/**
 * The owned roots exactly as `materializeInlineModules` leaves them, worked out without staging:
 * each inline Module at the root, revision and source its staging gives it (a released or changed
 * one is staged at the next revision, a missing one is created at revision 1), and every other
 * owned root as it is stored. Staging is deterministic, so a draft compile that stages in memory
 * and a preview plan that reads what preview preparation staged name the same roots.
 */
export const stagedOwnedModuleRoots = (
  candidate: DefinitionCandidateDraft,
  ownedRoots: readonly OwnedModuleRoot[],
): readonly (readonly unknown[])[] => {
  const owned = new Map(ownedRoots.map((root) => [root.key, root] as const));
  const sources = inlineModuleSources(candidate);
  const inlineKeys = new Set(sources.map((source) => source.key));
  return [
    ...sources.map((source) => {
      const sourceFingerprint = moduleSourceFingerprint(source);
      const existing = owned.get(source.key);
      if (existing === undefined)
        return [
          source.key,
          derivedOwnedModuleRootId(String(candidate.draft.rootId), source.key).toLowerCase(),
          1,
          null,
          sourceFingerprint,
        ];
      return [
        source.key,
        String(existing.rootId).toLowerCase(),
        stagesOwnedModule(existing, sourceFingerprint)
          ? existing.draftRevision + 1
          : existing.draftRevision,
        existing.currentReleaseRevision,
        sourceFingerprint,
      ];
    }),
    ...ownedRoots
      .filter((root) => !inlineKeys.has(root.key))
      .map((root) => [
        root.key,
        String(root.rootId).toLowerCase(),
        root.draftRevision,
        root.currentReleaseRevision,
        root.sourceFingerprint,
      ]),
  ];
};

const highestImpact = (reasons: readonly VersionImpactReason[]): VersionImpact => {
  const ranks = { patch: 0, minor: 1, major: 2 } as const;
  return reasons.reduce<VersionImpact>(
    (highest, reason) => (ranks[reason.impact] > ranks[highest] ? reason.impact : highest),
    "patch",
  );
};

/**
 * Compiles every inline Module once, in dependency order, against the current release of each
 * Module it depends on, and appends a release at `version` for each one that changed; that same
 * output is compared with the latest release and judged as the release. A sibling released
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
    const sourceFingerprint = moduleSourceFingerprint(source);
    const module = validateCandidate(
      context,
      await transaction.readCandidate(root.rootId),
      prepareDefinitionPublicationCommandSchema.parse({
        rootId: root.rootId,
        expectedDraftRevision: root.draftRevision,
      }),
    );
    if (module.draft.kind !== "module" || module.draft.sourceFingerprint !== sourceFingerprint)
      return refuse("DEFINITION_SOURCE_EVIDENCE_MISMATCH");
    const dependencies = await resolveDependencies(transaction, catalogue, module);
    await assertNoCycle(transaction, module, dependencies.modules);
    const resolution = buildResolution(module, dependencies, version);
    const retained = readRetainedApplicationModule(candidate, module, dependencies, resolution);
    if (retained !== undefined) {
      const append = { ...retained.append, draft: module.draft, releaseNote };
      if (retained.released) await transaction.appendModuleRelease(append);
      steps.push({ ...retained, candidate: module, append });
      continue;
    }
    const compiled = compileModuleCandidate(
      module,
      dependencies,
      resolution,
      catalogue.permissions,
    );
    const output = compiled.output;
    const impact = compareDefinitionVersionImpactWithEvidence({
      kind: "module",
      validationContractVersion: "4.1.0",
      releaseHistory: module.releaseHistory,
      candidate: output.canonical,
    });
    // A Module is released again when a Module it depends on was, even with no change of its own,
    // so every release in one Application pins each Module at exactly one release.
    const latest = module.releaseHistory.latestRelease as {
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
    const released = impact.outcome !== "no_change" || repinned;
    const reasons = impact.outcome === "no_change" ? [] : impact.reasons;
    if (released) assertReleasable(compiled, module.releaseHistory, catalogue.permissions);
    const append: DefinitionReleaseAppend = {
      draft: module.draft,
      compilationOutput: output,
      assignedVersion: version,
      reasons,
      dependencyManifest: manifestFor(dependencies, output, resolution),
      resolutionSnapshot: resolution,
      validationContractVersion: "4.1.0",
      releaseNote,
    };
    if (released) await transaction.appendModuleRelease(append);
    steps.push({ output, reasons, append, dependencies, released, candidate: module });
  }
  return steps;
};

/**
 * The Application compiled once at `version` against the current release of every Module it
 * names. A release of it (publication, preview) judges this same output with `assertReleasable`.
 */
const compileApplication = async (
  transaction: DefinitionPublicationTransaction,
  catalogue: DefinitionPublicationCatalogue,
  candidate: DefinitionDraftCandidate | DefinitionPublicationCandidate,
  version: string,
  pinned?: readonly ExactDefinitionDependency[],
) => {
  const dependencies = await resolveDependencies(transaction, catalogue, candidate, pinned);
  await assertNoCycle(transaction, candidate, dependencies.modules);
  const resolution = buildResolution(candidate, dependencies, version);
  const { request, output, dependencyOutputs } = compileApplicationCandidate(
    candidate,
    dependencies,
    resolution,
    catalogue.permissions,
  );
  if (output.kind !== "application") return refuse("DEFINITION_COMPILATION_REFUSED");
  return {
    request,
    output,
    dependencyOutputs,
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
  const latest = candidate.releaseHistory.latestRelease;
  // A release after one of an earlier definition contract is a major change of the whole definition.
  if (latest === null)
    return candidate.releaseHistory.supersededReleaseVersion === null
      ? []
      : [definitionContractChangedReason("application")];
  const own = compareDefinitionVersionImpactWithEvidence({
    kind: "application",
    validationContractVersion: applicationValidationContractVersion,
    releaseHistory: candidate.releaseHistory,
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
  // A platform operation or connection type the release pins was republished by the platform: the
  // application is released again against it, or its bound controls stop resolving.
  const platformChanges: VersionImpactReason[] =
    canonicalJson(candidate.latestPlatformPins) ===
    canonicalJson(platformPins(application.manifest))
      ? []
      : [
          {
            impact: "minor",
            code: "dependency_requirement_changed",
            location: { componentKind: "dependency", property: "version_requirement" },
          },
        ];
  return [
    ...(own.outcome === "release_required" ? own.reasons : []),
    ...modules.flatMap((module) => module.reasons),
    ...usedChanges,
    ...platformChanges,
  ].sort((left, right) => (canonicalJson(left) < canonicalJson(right) ? -1 : 1));
};

/** Plan both version passes in memory; only publication persists the resulting releases. */
export const planApplicationPublication = async (
  context: SessionContext,
  transaction: DefinitionPublicationTransaction,
  catalogue: DefinitionPublicationCatalogue,
  candidate: DefinitionPublicationCandidate,
  roots: ReadonlyMap<string, OwnedModuleRoot>,
  releaseNote: string,
  pinned?: readonly ExactDefinitionDependency[],
): Promise<ApplicationPublicationState> => {
  const latestVersion = latestReleaseVersion(candidate) ?? undefined;
  const provisional =
    latestVersion === undefined ? "1.0.0" : assignNextDefinitionVersion(latestVersion, "major");
  const pass = async (version: string, pins?: typeof pinned) => {
    const application = await compileApplicationWithInlineModules(
      context,
      transaction,
      catalogue,
      candidate,
      { version, pinned: pins, releaseNote },
    );
    return {
      modules: application.modules,
      application,
      reasons: publicationReasons(candidate, roots, application.modules, application),
    };
  };
  const provisionalReasons = (await pass(provisional)).reasons;
  if (latestVersion !== undefined && provisionalReasons.length === 0)
    refuse("DEFINITION_NO_CHANGE");
  const version =
    latestVersion === undefined
      ? "1.0.0"
      : assignNextDefinitionVersion(latestVersion, highestImpact(provisionalReasons));
  const { modules, application, reasons } = await pass(version, pinned);
  assertReleasable(application, candidate.releaseHistory, catalogue.permissions);
  if (canonicalJson(reasons) !== canonicalJson(provisionalReasons))
    refuse("DEFINITION_VERSION_REFUSED");
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
    moduleReleases: modules.map((module) => module.append),
  };
};

/**
 * The inline Modules whose current release already is what their publication would leave current.
 * A Module qualifies when its source fingerprint equals its release's, every sibling it depends on
 * qualifies, and its release pins exactly the releases its dependencies resolve to now. Its
 * publication would compile it, find no change and no new pin, and not release it, so a draft
 * compile takes the release as it is instead of compiling it again.
 */
export const releasedUnchangedModules = async (
  transaction: DefinitionPublicationReader,
  candidate: DefinitionCandidateDraft,
  ownedRoots: readonly OwnedModuleRoot[],
): Promise<ReadonlySet<string>> => {
  const owned = new Map(ownedRoots.map((root) => [root.key, root] as const));
  const sources = inlineModuleSources(candidate);
  const inlineKeys = new Set(sources.map((source) => source.key));
  const releasedRoots = ownedRoots.filter((root) => root.currentReleaseRevision !== null);
  const releases = await transaction.readModuleReleases(
    candidate.draft.organizationId,
    releasedRoots.map((root) => ({
      rootId: root.rootId,
      releaseRevision: root.currentReleaseRevision!,
    })),
  );
  const currentReleases = new Map(releasedRoots.map((root, index) => [root.key, releases[index]]));
  const dependenciesByKey = new Map(
    sources.map((source) => [
      source.key,
      moduleDependencies(source).map((dependency) => dependency.module),
    ]),
  );
  const usedKeys = [
    ...new Set(
      sources
        .filter((source) => {
          const root = owned.get(source.key);
          return (
            root !== undefined &&
            root.currentReleaseRevision !== null &&
            currentReleases.get(source.key)?.sourceFingerprint === root.sourceFingerprint &&
            root.sourceFingerprint === moduleSourceFingerprint(source)
          );
        })
        .flatMap((source) =>
          dependenciesByKey.get(source.key)!.filter((key) => !inlineKeys.has(key)),
        ),
    ),
  ];
  const usedReleases = new Map(
    await Promise.all(
      usedKeys.map(
        async (key) =>
          [key, await selectCurrentModuleRelease(transaction, candidate, key)] as const,
      ),
    ),
  );
  const unchanged = new Set<string>();
  for (const source of sources) {
    const root = owned.get(source.key);
    if (
      root === undefined ||
      root.currentReleaseRevision === null ||
      currentReleases.get(source.key)?.sourceFingerprint !== root.sourceFingerprint ||
      root.sourceFingerprint !== moduleSourceFingerprint(source)
    )
      continue;
    const dependencies = dependenciesByKey.get(source.key)!;
    if (dependencies.some((key) => inlineKeys.has(key) && !unchanged.has(key))) continue;
    const release = currentReleases.get(source.key);
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
      const used = usedReleases.get(key);
      if (used === undefined) return refuse("DEFINITION_DEPENDENCY_MISSING");
      expected.push(`${String(used.rootId).toLowerCase()}:${String(used.releaseRevision)}`);
    }
    if (pinned.size === expected.length && expected.every((pin) => pinned.has(pin)))
      unchanged.add(source.key);
  }
  return unchanged;
};

/** The inline Module releases a draft compile holds in memory are never stored; the note only labels them. */
const draftCompileReleaseNote = "Compiled for the draft";

/** The shared validated release-plan producer for Studio, preview and publication. */
export const compileApplicationWithInlineModules = async (
  context: SessionContext,
  reader: DefinitionPublicationReader,
  catalogue: DefinitionPublicationCatalogue,
  candidate: DefinitionDraftCandidate | DefinitionPublicationCandidate,
  options: Readonly<{
    version?: string;
    pinned?: readonly ExactDefinitionDependency[] | undefined;
    releaseNote?: string;
  }> = {},
) => {
  const transaction = createDraftModuleOverlay(reader, context, candidate.draft);
  const ownedRoots = await transaction.readOwnedModuleRoots(String(candidate.draft.rootId));
  const unchanged = await releasedUnchangedModules(transaction, candidate, ownedRoots);
  const roots = await materializeInlineModules(transaction, candidate, ownedRoots, unchanged);
  const latestVersion = latestReleaseVersion(candidate);
  const version =
    options.version ??
    (latestVersion === null ? "1.0.0" : assignNextDefinitionVersion(latestVersion, "major"));
  const moduleCompilations = await releaseInlineModules(
    context,
    transaction,
    catalogue,
    candidate,
    roots,
    version,
    options.releaseNote ?? draftCompileReleaseNote,
    unchanged,
  );
  const application = await compileApplication(
    transaction,
    catalogue,
    candidate,
    version,
    options.pinned,
  );
  return {
    ...application,
    modules: moduleCompilations.filter((module) => module.released),
    moduleCompilations,
  };
};

/** One compiled Application with its inline Module releases: what a preview or publication releases. */
export type ApplicationReleasePlan = Awaited<
  ReturnType<typeof compileApplicationWithInlineModules>
>;
