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
const applicationDraftCompilations = new Map<string, ApplicationDraftCompilation>();

const deepFreeze = <Value>(value: Value): Value => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(Reflect.get(value, key));
  Object.freeze(value);
  return value;
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
