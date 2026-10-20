import type { ApplicationDraftCompilation } from "./definition-publication";
import type { DefinitionPublicationHistoryEvidence } from "../schema";
import type {
  DefinitionCandidateDraft,
  DefinitionDraftCandidate,
  DefinitionPublicationCandidate,
  DefinitionResolution,
  OwnedModuleRoot,
} from "./definition-publication-contracts";
import type { ResolvedDependencies } from "./definition-dependency-resolution";

const sameApplicationPublication = (
  retained: ApplicationDraftCompilation,
  application: DefinitionCandidateDraft,
): boolean =>
  retained.candidate.draft.rootId === application.draft.rootId &&
  retained.candidate.draft.organizationId === application.draft.organizationId &&
  retained.candidate.draft.publishedRevision === application.draft.publishedRevision;

/** The authenticated inputs of the same immutable staged Module revision, before a history read. */
export const readRetainedApplicationModuleCandidate = (
  application: DefinitionCandidateDraft,
  root: OwnedModuleRoot,
  sourceFingerprint: string,
): DefinitionPublicationCandidate | undefined => {
  if (root.sourceFingerprint !== sourceFingerprint) return undefined;
  for (const retained of [...applicationDraftCompilations.values()].reverse()) {
    if (!sameApplicationPublication(retained, application)) continue;
    const step = retained.releasePlan.moduleCompilations.find(
      ({ candidate }) =>
        candidate.draft.rootId === root.rootId &&
        candidate.draft.key === root.key &&
        candidate.draft.draftRevision === root.draftRevision &&
        candidate.draft.sourceFingerprint === sourceFingerprint &&
        (candidate.draft.publishedRevision ?? null) === root.currentReleaseRevision,
    );
    if (step !== undefined) return step.candidate;
  }
  return undefined;
};

/** A possible retained draft; the reader must check its live revision and fingerprints. */
export const readRetainedApplicationDraftCandidate = (
  organizationId: string,
  rootId: string,
  revision: number,
): DefinitionDraftCandidate | undefined => {
  for (const compilation of [...applicationDraftCompilations.values()].reverse()) {
    const candidate = compilation.candidate;
    if (
      candidate.draft.organizationId === organizationId &&
      candidate.draft.rootId === rootId &&
      candidate.draft.draftRevision === revision
    )
      return candidate;
  }
  return undefined;
};

/** Immutable history is reusable while the live Application publication anchor is unchanged. */
export const readRetainedApplicationPublicationHistory = (
  candidate: DefinitionCandidateDraft,
): DefinitionPublicationHistoryEvidence | undefined => {
  for (const compilation of [...applicationDraftCompilations.values()].reverse()) {
    if (
      compilation.candidate.draft.organizationId === candidate.draft.organizationId &&
      compilation.candidate.draft.rootId === candidate.draft.rootId &&
      compilation.publicationHistory?.anchorReleaseRevision ===
        (candidate.draft.publishedRevision ?? null)
    )
      return compilation.publicationHistory;
  }
  return undefined;
};

/** Keep the authenticated history read with the compilation that uses it, in the same retention. */
export const retainApplicationDraftPublicationHistory = (
  compilation: ApplicationDraftCompilation,
  publicationHistory: DefinitionPublicationHistoryEvidence,
): void => {
  for (const [key, retained] of applicationDraftCompilations) {
    if (retained === compilation && retained.publicationHistory === undefined) {
      applicationDraftCompilations.set(
        key,
        Object.freeze({
          ...retained,
          publicationHistory: deepFreeze(publicationHistory),
        }),
      );
      return;
    }
  }
};

/**
 * An unchanged staged Module from a retained Application compile. It is still staged, so its
 * current published release is older than this output. Reuse requires the same stored draft,
 * publication anchor, resolved identities and exact dependency releases, including fingerprints.
 * The existing bounded revision retention owns the output; there is no Module cache.
 */
export const readRetainedApplicationModule = (
  application: DefinitionCandidateDraft,
  module: DefinitionPublicationCandidate,
  dependencies: ResolvedDependencies,
  resolution: DefinitionResolution,
): ApplicationDraftCompilation["releasePlan"]["moduleCompilations"][number] | undefined => {
  for (const retained of [...applicationDraftCompilations.values()].reverse()) {
    if (!sameApplicationPublication(retained, application)) continue;
    const step = retained.releasePlan.moduleCompilations.find(
      ({ append }) =>
        append.draft.rootId === module.draft.rootId &&
        append.draft.draftRevision === module.draft.draftRevision &&
        append.draft.sourceFingerprint === module.draft.sourceFingerprint &&
        append.draft.publishedRevision === module.draft.publishedRevision &&
        append.resolutionSnapshot.fingerprint === resolution.fingerprint,
    );
    if (step === undefined) continue;
    if (
      step.dependencies.modules.length === dependencies.modules.length &&
      dependencies.modules.every((release, index) => {
        const previous = step.dependencies.modules[index]!;
        return (
          previous.rootId === release.rootId &&
          previous.releaseRevision === release.releaseRevision &&
          previous.releaseVersion === release.releaseVersion &&
          previous.contentFingerprint === release.contentFingerprint &&
          previous.resolutionFingerprint === release.resolutionFingerprint
        );
      }) &&
      step.dependencies.connections.length === dependencies.connections.length &&
      dependencies.connections.every((release, index) => {
        const previous = step.dependencies.connections[index]!;
        return (
          previous.rootId === release.rootId &&
          previous.releaseVersion === release.releaseVersion &&
          previous.contentFingerprint === release.contentFingerprint
        );
      })
    )
      return step;
  }
  return undefined;
};

/**
 * Compiled Application drafts that were already produced for one organisation, root, draft
 * revision and source fingerprint, so a second load or validation of that same draft revision does
 * not compile it again. Compilation is a pure function of the draft source, the exact resolved
 * dependencies and the platform catalogue, and the key names every one of them, so a changed
 * draft, another organisation or a different dependency resolution can never read an entry. An
 * entry holds the compile's authenticated inputs and outputs; authorisation runs before every
 * lookup and is never cached.
 */
const applicationDraftCompilationCacheLimit = 16;
// Page rendering, actions and API routes can load separate module runtimes in one process.
// They share the same immutable compilations; every caller still checks live authority and
// resolves the current dependency inputs before looking up this bounded cache.
const applicationDraftCompilationsKey = Symbol.for(
  "vortex.platform.application-draft-compilations",
);
const processCompilations = globalThis as typeof globalThis & {
  [applicationDraftCompilationsKey]?: Map<string, ApplicationDraftCompilation>;
};
const applicationDraftCompilations = (processCompilations[applicationDraftCompilationsKey] ??=
  new Map<string, ApplicationDraftCompilation>());

const deepFreeze = <Value>(value: Value): Value => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(Reflect.get(value, key));
  Object.freeze(value);
  return value;
};

// The compile of a key that is running now, so a second caller (the canvas compile and a preview
// move that follows a save) joins it instead of compiling the same revision beside it. An entry
// holds only pending work and is removed when it settles; a failed compile is never retained.
const runningCompilationsKey = Symbol.for("vortex.platform.application-draft-compilations-running");
const processRunning = globalThis as typeof globalThis & {
  [runningCompilationsKey]?: Map<string, Promise<ApplicationDraftCompilation>>;
};
const runningCompilations = (processRunning[runningCompilationsKey] ??= new Map<
  string,
  Promise<ApplicationDraftCompilation>
>());

/**
 * The retained compile of this key, the running one, or a new one. A caller that joined a compile
 * that failed compiles for itself, so another request's failure is never its answer.
 */
export const compileApplicationDraftOnce = async (
  key: string,
  compile: () => Promise<ApplicationDraftCompilation>,
): Promise<ApplicationDraftCompilation> => {
  const cached = readCachedApplicationDraftCompilation(key);
  if (cached !== undefined) return cached;
  const running = runningCompilations.get(key);
  if (running !== undefined) {
    try {
      return await running;
    } catch {
      return compile();
    }
  }
  const started = compile();
  runningCompilations.set(key, started);
  try {
    return await started;
  } finally {
    if (runningCompilations.get(key) === started) runningCompilations.delete(key);
  }
};

export const applicationDraftCompilationKey = (parts: readonly unknown[]): string =>
  JSON.stringify(parts);

export const readCachedApplicationDraftCompilation = (
  key: string,
): ApplicationDraftCompilation | undefined => {
  const cached = applicationDraftCompilations.get(key);
  if (cached === undefined) return undefined;
  applicationDraftCompilations.delete(key);
  applicationDraftCompilations.set(key, cached);
  return cached;
};

export const retainApplicationDraftCompilation = (
  key: string,
  compilation: ApplicationDraftCompilation,
): ApplicationDraftCompilation => {
  applicationDraftCompilations.delete(key);
  for (const oldest of applicationDraftCompilations.keys()) {
    if (applicationDraftCompilations.size < applicationDraftCompilationCacheLimit) break;
    applicationDraftCompilations.delete(oldest);
  }
  // The release plan holds this compile's own inputs (request, catalogue snapshot, dependency
  // outputs) by reference; nothing writes to them, so only the plan object itself is frozen
  // rather than walking those large trees again on every compile.
  const { releasePlan, ...projections } = compilation;
  const frozen = Object.freeze({
    ...deepFreeze(projections),
    releasePlan: Object.freeze(releasePlan),
  });
  applicationDraftCompilations.set(key, frozen);
  return frozen;
};
