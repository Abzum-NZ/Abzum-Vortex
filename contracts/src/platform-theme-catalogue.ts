import {
  platformThemeReleaseV2Schema,
  type PlatformThemeReleaseV2,
  type PlatformThemeTokenRoleKeyV2,
} from "./application-composition-v2";

const deepFreeze = <Value>(value: Value): Value => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
};

type PlatformThemeTokenValueV2 = PlatformThemeReleaseV2["tokens"][string];

/**
 * The token values of the registered platform theme, keyed by the shared token-role vocabulary
 * (`platformThemeTokenRolesV2`). The `satisfies` clause makes a role that the vocabulary adds
 * without a value here a compile-time error, so the registered release always maps every role.
 */
const tokens = {
  background: { kind: "color_pair", light: "#FFFFFF", dark: "#0F172A", role: "background" },
  surface: { kind: "color_pair", light: "#F8FAFC", dark: "#1E293B", role: "background" },
  text: { kind: "color_pair", light: "#0F172A", dark: "#F8FAFC", role: "foreground" },
  muted_text: { kind: "color_pair", light: "#475569", dark: "#CBD5E1", role: "foreground" },
  border_color: { kind: "color_pair", light: "#CBD5E1", dark: "#334155" },
  border: { kind: "border", widthRem: 0.0625, style: "solid", colorToken: "border_color" },
  primary: { kind: "color_pair", light: "#1D4ED8", dark: "#93C5FD" },
  primary_foreground: {
    kind: "color_pair",
    light: "#FFFFFF",
    dark: "#0B1220",
    role: "foreground",
  },
  secondary: { kind: "color_pair", light: "#E2E8F0", dark: "#334155" },
  secondary_foreground: {
    kind: "color_pair",
    light: "#0F172A",
    dark: "#F8FAFC",
    role: "foreground",
  },
  danger: { kind: "color_pair", light: "#B91C1C", dark: "#F87171" },
  danger_foreground: {
    kind: "color_pair",
    light: "#FFFFFF",
    dark: "#000000",
    role: "foreground",
  },
  danger_text: { kind: "color_pair", light: "#B91C1C", dark: "#F87171", role: "foreground" },
  warning_text: { kind: "color_pair", light: "#92400E", dark: "#FBBF24", role: "foreground" },
  info_text: { kind: "color_pair", light: "#1D4ED8", dark: "#60A5FA", role: "foreground" },
  focus: { kind: "focus", colorToken: "primary", widthRem: 0.125 },
  body: { kind: "typography", family: "body", sizeRem: 1, lineHeight: 1.5, weight: 400 },
  heading: { kind: "typography", family: "heading", sizeRem: 1.5, lineHeight: 1.25, weight: 600 },
  space_xs: { kind: "spacing", rem: 0.25 },
  space_sm: { kind: "spacing", rem: 0.5 },
  space_md: { kind: "spacing", rem: 1 },
  space_lg: { kind: "spacing", rem: 1.5 },
  radius_sm: { kind: "corners", rem: 0.125 },
  radius_md: { kind: "corners", rem: 0.25 },
  radius_lg: { kind: "corners", rem: 0.5 },
  elevation_low: { kind: "elevation", level: 1 },
  elevation_high: { kind: "elevation", level: 3 },
  density: { kind: "density", value: "comfortable" },
} satisfies Record<PlatformThemeTokenRoleKeyV2, PlatformThemeTokenValueV2>;

/**
 * The registered platform theme release: the one source of application theme base
 * values for authored definitions and for the renderer. It is parsed through the
 * release contract at module load and deep-frozen. Its colour pairs declare their
 * foreground/background roles so readability is judged by declared role rather than
 * by token name. Its token keys are exactly the shared token-role vocabulary
 * (`platformThemeTokenRolesV2`), so the release maps every renderer role and no
 * consumer falls back to a second token convention. Fingerprints are the canonical-JSON
 * SHA-256 values the publication catalogue derives from the same token content, matching
 * IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2's derivation.
 */
export const DEFAULT_PLATFORM_THEME_RELEASE_V2: PlatformThemeReleaseV2 = deepFreeze(
  platformThemeReleaseV2Schema.parse({
    catalogueThemeId: "3f0a2b14-9c6d-4e58-8a71-6d2e5f4b1c09",
    releaseVersion: "2.0.0",
    contentFingerprint: "sha256:fbb5b219abf1012517b1eb57d0438d0b9ac989039b38bb48ede5178f6cfa53f3",
    catalogueFingerprint: "sha256:6df126d1e56dddf89e7501b508be4822329d5d0d2230b66041f7f9228996ff83",
    tokens,
  }),
);
