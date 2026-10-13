import {
  platformThemeReleaseSchema,
  type PlatformThemeRelease,
  type PlatformThemeTokenRoleKey,
} from "../definition/application-composition";
import { platformThemeReleaseContentHash } from "../definition/catalogue-release-content-hashes";
import source from "../catalogue/catalogue/platform-theme-catalogue.source.json";

const deepFreeze = <Value>(value: Value): Value => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
};

/**
 * The current release's token values live in catalogue/platform-theme-catalogue.source.json, keyed
 * by the shared token-role vocabulary (`platformThemeTokenRoles`). Assigning them to a record
 * over that vocabulary makes a role that the vocabulary adds without a value there a compile-time
 * error, so the registered release always maps every role, including every shadcn role.
 */
const currentTokens: Record<PlatformThemeTokenRoleKey, unknown> =
  source.PLATFORM_THEME_RELEASE_3_0_0.tokens;

/**
 * One registered platform theme release: a source definition plus its canonical-JSON content hash,
 * computed once as the catalogue loads. It is parsed through the release contract and deep-frozen.
 */
const release = (definition: {
  catalogueThemeId: string;
  releaseVersion: string;
  tokens: unknown;
}): PlatformThemeRelease =>
  deepFreeze(
    platformThemeReleaseSchema.parse({
      catalogueThemeId: definition.catalogueThemeId,
      releaseVersion: definition.releaseVersion,
      ...platformThemeReleaseContentHash(definition),
      tokens: definition.tokens,
    }),
  );

/**
 * The 2.0.0 release stays published unchanged, so an application pinned to it keeps its exact
 * published theme and only the new shadcn roles fall back to the registered release at render time.
 */
export const PLATFORM_THEME_RELEASE_2_0_0: PlatformThemeRelease = release(
  source.PLATFORM_THEME_RELEASE_2_0_0,
);

/**
 * The 3.0.0 release maps every role in the shared vocabulary, including every shadcn role, to the
 * shadcn base-nova neutral values. Its colour pairs declare their foreground/background roles so
 * readability is judged by declared role rather than by token name.
 */
export const PLATFORM_THEME_RELEASE_3_0_0: PlatformThemeRelease = release({
  catalogueThemeId: source.PLATFORM_THEME_RELEASE_3_0_0.catalogueThemeId,
  releaseVersion: source.PLATFORM_THEME_RELEASE_3_0_0.releaseVersion,
  tokens: currentTokens,
});

/**
 * The registered platform theme release: the one source of application theme base values for
 * authored definitions and for the renderer. Shipped definitions pin this release, so moving it
 * moves every shipped theme pin together.
 */
export const DEFAULT_PLATFORM_THEME_RELEASE: PlatformThemeRelease = PLATFORM_THEME_RELEASE_3_0_0;
