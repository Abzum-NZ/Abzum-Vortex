import type { ApplicationDraftCompilation } from "./definition-publication";

/**
 * Compiled Application drafts that were already produced for one organisation, root, draft
 * revision and source fingerprint, so a second load or validation of that same draft revision does
 * not compile it again. Compilation is a pure function of the draft source, the exact resolved
 * dependencies and the platform catalogue, and the key names every one of them, so a changed
 * draft, another organisation or a different dependency resolution can never read an entry. An
 * entry holds only what the compile itself returned; authorisation runs before every lookup and
 * is never cached.
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
