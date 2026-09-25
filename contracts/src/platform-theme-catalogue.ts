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
 * The token values of the registered platform theme live in
 * catalogue/platform-theme-catalogue.source.json, keyed by the shared token-role vocabulary
 * (`platformThemeTokenRolesV2`). Assigning them to a record over that vocabulary makes a role that
 * the vocabulary adds without a value there a compile-time error, so the registered release
 * always maps every role.
 */
const tokens: Record<PlatformThemeTokenRoleKeyV2, unknown> = source.tokens;

/**
 * The registered platform theme release: the one source of application theme base
 * values for authored definitions and for the renderer. It is parsed through the
 * release contract at module load and deep-frozen. Its colour pairs declare their
 * foreground/background roles so readability is judged by declared role rather than
 * by token name. Its token keys are exactly the shared token-role vocabulary
 * (`platformThemeTokenRolesV2`), so the release maps every renderer role and no
 * consumer falls back to a second token convention. Its fingerprints are the canonical-JSON
 * SHA-256 values that `pnpm catalogue:fingerprints` derives from the same token content into
 * catalogue/catalogue-fingerprints.generated.json, merged in by theme id and release version and
 * never written by hand.
 */
export const DEFAULT_PLATFORM_THEME_RELEASE_V2: PlatformThemeReleaseV2 = deepFreeze(
  platformThemeReleaseV2Schema.parse({
    catalogueThemeId: source.catalogueThemeId,
    releaseVersion: source.releaseVersion,
    ...generatedReleaseFingerprints(
      "platformThemes",
      `${source.catalogueThemeId}:${source.releaseVersion}`,
    ),
    tokens,
  }),
);
