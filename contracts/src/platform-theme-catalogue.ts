import {
  platformThemeReleaseV2Schema,
  type PlatformThemeReleaseV2,
} from "./application-composition-v2";

const deepFreeze = <Value>(value: Value): Value => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
};

/**
 * The registered platform theme release: the one source of application theme base
 * values for authored definitions and for the renderer. It is parsed through the
 * release contract at module load and deep-frozen. Its colour pairs declare their
 * foreground/background roles so readability is judged by declared role rather than
 * by token name. Fingerprints are the canonical-JSON SHA-256 values the publication
 * catalogue derives from the same token content, matching
 * IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2's derivation.
 */
export const DEFAULT_PLATFORM_THEME_RELEASE_V2: PlatformThemeReleaseV2 = deepFreeze(
  platformThemeReleaseV2Schema.parse({
    catalogueThemeId: "3f0a2b14-9c6d-4e58-8a71-6d2e5f4b1c09",
    releaseVersion: "1.0.0",
    contentFingerprint: "sha256:9b44bfbdaf3b2e8bff5341d2dc116fa2b66b65bb2700e8861d2465c8a756e05b",
    catalogueFingerprint: "sha256:85fbfc0e57c44afb31e5bd6278d1191fdc16d7656d7947f3b47fbde89760c991",
    tokens: {
      background: { kind: "color_pair", light: "#FFFFFF", dark: "#0F172A", role: "background" },
      surface: { kind: "color_pair", light: "#F8FAFC", dark: "#1E293B" },
      foreground: { kind: "color_pair", light: "#0F172A", dark: "#F8FAFC", role: "foreground" },
      muted_foreground: {
        kind: "color_pair",
        light: "#475569",
        dark: "#CBD5E1",
        role: "foreground",
      },
      brand: { kind: "color_pair", light: "#1D4ED8", dark: "#93C5FD" },
      brand_foreground: {
        kind: "color_pair",
        light: "#FFFFFF",
        dark: "#0B1220",
        role: "foreground",
      },
      border_color: { kind: "color_pair", light: "#CBD5E1", dark: "#334155" },
      border: { kind: "border", widthRem: 0.0625, style: "solid", colorToken: "border_color" },
      focus: { kind: "focus", colorToken: "brand", widthRem: 0.125 },
      body_text: { kind: "typography", family: "body", sizeRem: 1, lineHeight: 1.5, weight: 400 },
      heading_text: {
        kind: "typography",
        family: "heading",
        sizeRem: 1.5,
        lineHeight: 1.25,
        weight: 600,
      },
      space_unit: { kind: "spacing", rem: 0.5 },
      corner_radius: { kind: "corners", rem: 0.375 },
      elevation_low: { kind: "elevation", level: 1 },
      density: { kind: "density", value: "comfortable" },
    },
  }),
);
