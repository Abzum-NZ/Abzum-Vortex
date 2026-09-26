import {
  platformThemeReleaseV2Schema,
  type PlatformThemeReleaseV2,
  type PlatformThemeTokenRoleKeyV2,
} from "./application-composition-v2";
import { generatedReleaseFingerprints } from "./catalogue/generated-fingerprints";
import source from "./catalogue/platform-theme-catalogue.source.json";

const deepFreeze = <Value>(value: Value): Value => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
};

/**
 * The current release's token values live in catalogue/platform-theme-catalogue.source.json, keyed
 * by the shared token-role vocabulary (`platformThemeTokenRolesV2`). Assigning them to a record
 * over that vocabulary makes a role that the vocabulary adds without a value there a compile-time
 * error, so the registered release always maps every role, including every shadcn role.
 */
const currentTokens: Record<PlatformThemeTokenRoleKeyV2, unknown> =
  source.PLATFORM_THEME_RELEASE_3_0_0.tokens;

/**
 * One registered platform theme release: a source definition plus the canonical-JSON SHA-256
 * fingerprints that `pnpm catalogue:fingerprints` derives from the same token content into
 * catalogue/catalogue-fingerprints.generated.json, merged in by theme id and release version and
 * never written by hand. It is parsed through the release contract at module load and deep-frozen.
 */
const release = (definition: {
  catalogueThemeId: string;
  releaseVersion: string;
  tokens: unknown;
}): PlatformThemeReleaseV2 =>
  deepFreeze(
    platformThemeReleaseV2Schema.parse({
      catalogueThemeId: definition.catalogueThemeId,
      releaseVersion: definition.releaseVersion,
      ...generatedReleaseFingerprints(
        "platformThemes",
        `${definition.catalogueThemeId}:${definition.releaseVersion}`,
      ),
      tokens: definition.tokens,
    }),
  );

/**
 * The 2.0.0 release stays published unchanged, so an application pinned to it keeps its exact
 * published theme and only the new shadcn roles fall back to the registered release at render time.
 */
export const PLATFORM_THEME_RELEASE_2_0_0: PlatformThemeReleaseV2 = release(
  source.PLATFORM_THEME_RELEASE_2_0_0,
);

/**
 * The 3.0.0 release maps every role in the shared vocabulary, including every shadcn role, to the
 * shadcn base-nova neutral values. Its colour pairs declare their foreground/background roles so
 * readability is judged by declared role rather than by token name.
 */
export const PLATFORM_THEME_RELEASE_3_0_0: PlatformThemeReleaseV2 = release({
  catalogueThemeId: source.PLATFORM_THEME_RELEASE_3_0_0.catalogueThemeId,
  releaseVersion: source.PLATFORM_THEME_RELEASE_3_0_0.releaseVersion,
  tokens: currentTokens,
});

/**
 * The registered platform theme release: the one source of application theme base values for
 * authored definitions and for the renderer. Shipped definitions pin this release, so moving it
 * moves every shipped theme pin together.
 */
export const DEFAULT_PLATFORM_THEME_RELEASE_V2: PlatformThemeReleaseV2 = PLATFORM_THEME_RELEASE_3_0_0;
