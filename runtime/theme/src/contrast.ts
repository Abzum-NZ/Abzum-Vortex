import "server-only";

import { platformThemeTokenRolesV2, type DefinitionRuleFailure } from "@vortex/contracts";
import { createLocatedFailure } from "./errors";
import type {
  ThemeResolutionOptions,
  ThemeTokenValueV2,
  ThemeValidationFailure,
} from "./types";

export const WCAG_AA_NORMAL_TEXT_MIN_CONTRAST = 4.5;
export const WCAG_AA_LARGE_TEXT_MIN_CONTRAST = 3.0;
export const WCAG_AA_NON_TEXT_MIN_CONTRAST = 3.0;

/** The vocabulary's brand fill, which the renderer also paints on the surface as the accent. */
const ACCENT_TOKEN_KEY = "primary";

export const DEFAULT_LIGHT_SURFACE = "#FFFFFF";
export const DEFAULT_DARK_SURFACE = "#000000";

type RgbaColor = Readonly<{ r: number; g: number; b: number; a: number }>;

function parseHex(hex: string): RgbaColor {
  const clean = hex.startsWith("#") ? hex.slice(1) : hex;
  if (!/^(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(clean))
    throw new Error(`Invalid hex color: "${hex}"`);
  const expanded =
    clean.length <= 4
      ? [...clean].map((character) => character + character).join("")
      : clean;
  return {
    r: parseInt(expanded.slice(0, 2), 16),
    g: parseInt(expanded.slice(2, 4), 16),
    b: parseInt(expanded.slice(4, 6), 16),
    a: expanded.length === 8 ? parseInt(expanded.slice(6, 8), 16) / 255 : 1,
  };
}

function composite(foreground: RgbaColor, background: RgbaColor): RgbaColor {
  const alpha = foreground.a + background.a * (1 - foreground.a);
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
    g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
    b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
    a: alpha,
  };
}

function requireOpaque(color: RgbaColor, role: string): RgbaColor {
  if (color.a !== 1) throw new Error(`${role} must resolve to an opaque color`);
  return color;
}

function channelLuminance(channel: number): number {
  const sRGB = channel / 255;
  return sRGB <= 0.04045 ? sRGB / 12.92 : Math.pow((sRGB + 0.055) / 1.055, 2.4);
}

function colorLuminance({ r, g, b }: RgbaColor): number {
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

/** Calculates luminance after composing a translucent color over an opaque background. */
export function relativeLuminance(hex: string, background = DEFAULT_LIGHT_SURFACE): number {
  const backdrop = requireOpaque(parseHex(background), "Luminance background");
  return colorLuminance(composite(parseHex(hex), backdrop));
}

/**
 * Calculates foreground/background contrast after alpha-compositing both layers onto
 * an opaque canvas. Argument order is significant when either color is translucent.
 */
export function contrastRatio(
  foreground: string,
  background: string,
  canvas = DEFAULT_LIGHT_SURFACE,
): number {
  const opaqueCanvas = requireOpaque(parseHex(canvas), "Contrast canvas");
  const effectiveBackground = composite(parseHex(background), opaqueCanvas);
  const effectiveForeground = composite(parseHex(foreground), effectiveBackground);
  const lumA = colorLuminance(effectiveForeground);
  const lumB = colorLuminance(effectiveBackground);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Whether a theme's catalogue declares any colour role. Every materialised theme comes from a
 * platform release that declares the shared vocabulary's roles, so readability is judged only
 * by those declarations and never by token names. A theme that declares no roles, or declares
 * one other than the vocabulary's, is refused by `validateThemeContrast`.
 */
export function declaresColorRoles(tokens: Readonly<Record<string, ThemeTokenValueV2>>): boolean {
  return Object.values(tokens).some(
    (token) => token.kind === "color_pair" && token.role !== undefined,
  );
}

/**
 * The surface a theme paints text and brand colours on: the colour pair the shared vocabulary
 * declares with the `background` role. The priority order only settles which declared
 * background role wins; token names never decide whether a colour is a surface.
 */
export function findThemeSurface(
  tokens: Readonly<Record<string, ThemeTokenValueV2>>,
): Readonly<{ key?: string; light: string; dark: string; name: string }> {
  const backgrounds = Object.keys(tokens)
    .sort()
    .flatMap((key) => {
      const token = tokens[key];
      return token?.kind === "color_pair" && token.role === "background"
        ? [[key, token] as const]
        : [];
    });
  const exactPriority = ["background", "canvas", "surface", "bg", "page_background", "app_background"];
  const selected =
    exactPriority.flatMap((candidate) =>
      backgrounds.filter(([key]) => key.toLowerCase() === candidate),
    )[0] ?? backgrounds[0];
  if (selected === undefined)
    return {
      light: DEFAULT_LIGHT_SURFACE,
      dark: DEFAULT_DARK_SURFACE,
      name: "default surface",
    };
  return {
    key: selected[0],
    light: selected[1].light,
    dark: selected[1].dark,
    name: selected[0],
  };
}

export function validateThemeContrast(
  tokens: Readonly<Record<string, ThemeTokenValueV2>>,
  options?: ThemeResolutionOptions | undefined,
): { failures: ThemeValidationFailure[]; ruleFailures: DefinitionRuleFailure[] } {
  const failures: ThemeValidationFailure[] = [];
  const ruleFailures: DefinitionRuleFailure[] = [];

  const addFailure = (params: {
    code: string;
    ruleCode?: string;
    family?: "invalid_value" | "unsafe_content" | "broken_reference";
    message: string;
    tokenKey?: string;
  }) => {
    const located = createLocatedFailure({
      ...params,
      documentKey: options?.documentKey,
    });
    failures.push(located.failure);
    ruleFailures.push(located.ruleFailure);
  };

  // The renderer paints each vocabulary colour by its key, so a vocabulary colour must carry
  // exactly the role the vocabulary declares for it; otherwise the checks below would judge it
  // as something other than what is painted.
  for (const role of platformThemeTokenRolesV2) {
    const token = tokens[role.key];
    if (token?.kind !== "color_pair") continue;
    const declared: string | undefined = "colorRole" in role ? role.colorRole : undefined;
    if (token.role !== declared)
      addFailure({
        code: "COLOR_ROLE_MISMATCH",
        family: "invalid_value",
        message:
          declared === undefined
            ? `Colour token "${role.key}" must not declare a colour role; the shared token vocabulary gives it none`
            : `Colour token "${role.key}" must declare the "${declared}" colour role the shared token vocabulary gives it`,
        tokenKey: role.key,
      });
  }

  const surface = findThemeSurface(tokens);
  if (surface.key === undefined) {
    addFailure({
      code: "MISSING_BACKGROUND_ROLE",
      family: "invalid_value",
      message: "A theme must declare a colour with the background role",
    });
  }
  const lightSurface = surface.light;
  const darkSurface = surface.dark;
  const surfaceName = surface.name;
  // A fill's foreground is the vocabulary pair `<fill>_foreground`; nothing else marks it.
  const pairedForegroundKeys = new Set<string>();
  for (const key of Object.keys(tokens).sort()) {
    if (tokens[key]?.kind !== "color_pair") continue;
    if (tokens[`${key}_foreground`]?.kind === "color_pair")
      pairedForegroundKeys.add(`${key}_foreground`);
  }

  // Validate each declared text/foreground colour against what it is painted on, and each
  // declared foreground against its paired fill. Token names never decide a colour's role.
  for (const key of Object.keys(tokens).sort()) {
    const token = tokens[key];
    if (token === undefined) continue;
    if (token.kind !== "color_pair") continue;
    if (key === surface.key) continue;

    // A paired foreground is evaluated against its declared companion below. It
    // need not also contrast with the application surface on which it is not used.
    if (token.role === "foreground" && !pairedForegroundKeys.has(key)) {
      const lightRatio = contrastRatio(token.light, lightSurface, DEFAULT_LIGHT_SURFACE);
      if (lightRatio < WCAG_AA_NORMAL_TEXT_MIN_CONTRAST) {
        addFailure({
          code: "INSUFFICIENT_CONTRAST",
          family: "invalid_value",
          message: `Text color token "${key}" has insufficient light mode contrast ratio (${lightRatio.toFixed(2)}:1 < ${WCAG_AA_NORMAL_TEXT_MIN_CONTRAST}:1) against ${surfaceName} (${lightSurface})`,
          tokenKey: key,
        });
      }
      const darkRatio = contrastRatio(token.dark, darkSurface, DEFAULT_DARK_SURFACE);
      if (darkRatio < WCAG_AA_NORMAL_TEXT_MIN_CONTRAST) {
        addFailure({
          code: "INSUFFICIENT_CONTRAST",
          family: "invalid_value",
          message: `Text color token "${key}" has insufficient dark mode contrast ratio (${darkRatio.toFixed(2)}:1 < ${WCAG_AA_NORMAL_TEXT_MIN_CONTRAST}:1) against ${surfaceName} (${darkSurface})`,
          tokenKey: key,
        });
      }
    }

    // The renderer also paints the brand fill directly on the surface as the accent
    // (selection bars, checked controls, active tabs), so it must stay visible there.
    if (key === ACCENT_TOKEN_KEY) {
      const lightRatio = contrastRatio(token.light, lightSurface, DEFAULT_LIGHT_SURFACE);
      if (lightRatio < WCAG_AA_NON_TEXT_MIN_CONTRAST) {
        addFailure({
          code: "INSUFFICIENT_CONTRAST",
          family: "invalid_value",
          message: `Brand color token "${key}" has insufficient light mode contrast ratio (${lightRatio.toFixed(2)}:1 < ${WCAG_AA_NON_TEXT_MIN_CONTRAST}:1) against ${surfaceName} (${lightSurface})`,
          tokenKey: key,
        });
      }
      const darkRatio = contrastRatio(token.dark, darkSurface, DEFAULT_DARK_SURFACE);
      if (darkRatio < WCAG_AA_NON_TEXT_MIN_CONTRAST) {
        addFailure({
          code: "INSUFFICIENT_CONTRAST",
          family: "invalid_value",
          message: `Brand color token "${key}" has insufficient dark mode contrast ratio (${darkRatio.toFixed(2)}:1 < ${WCAG_AA_NON_TEXT_MIN_CONTRAST}:1) against ${surfaceName} (${darkSurface})`,
          tokenKey: key,
        });
      }
    }

    // Check paired tokens: the vocabulary names a fill's foreground `<fill>_foreground`.
    const foregroundKey = `${key}_foreground`;
    const pairedForeground = tokens[foregroundKey];
    if (pairedForeground !== undefined && pairedForeground.kind === "color_pair") {
      const lightRatio = contrastRatio(pairedForeground.light, token.light, lightSurface);
      if (lightRatio < WCAG_AA_NORMAL_TEXT_MIN_CONTRAST) {
        addFailure({
          code: "INSUFFICIENT_CONTRAST",
          family: "invalid_value",
          message: `Paired color token "${foregroundKey}" has insufficient light mode contrast ratio (${lightRatio.toFixed(2)}:1 < ${WCAG_AA_NORMAL_TEXT_MIN_CONTRAST}:1) against "${key}"`,
          tokenKey: foregroundKey,
        });
      }
      const darkRatio = contrastRatio(pairedForeground.dark, token.dark, darkSurface);
      if (darkRatio < WCAG_AA_NORMAL_TEXT_MIN_CONTRAST) {
        addFailure({
          code: "INSUFFICIENT_CONTRAST",
          family: "invalid_value",
          message: `Paired color token "${foregroundKey}" has insufficient dark mode contrast ratio (${darkRatio.toFixed(2)}:1 < ${WCAG_AA_NORMAL_TEXT_MIN_CONTRAST}:1) against "${key}"`,
          tokenKey: foregroundKey,
        });
      }
    }
  }

  // Check explicit contrast pairs if provided in options
  if (options?.contrastPairs !== undefined) {
    for (const pair of options.contrastPairs) {
      const fgToken = tokens[pair.foregroundTokenKey];
      const bgToken = tokens[pair.backgroundTokenKey];
      const requiredRatio =
        pair.usage === "large_text"
          ? WCAG_AA_LARGE_TEXT_MIN_CONTRAST
          : pair.usage === "non_text"
            ? WCAG_AA_NON_TEXT_MIN_CONTRAST
            : WCAG_AA_NORMAL_TEXT_MIN_CONTRAST;
      if (
        pair.minimumRatio !== undefined &&
        (!Number.isFinite(pair.minimumRatio) ||
          pair.minimumRatio < requiredRatio ||
          pair.minimumRatio > 21)
      ) {
        addFailure({
          code: "INVALID_CONTRAST_RATIO",
          family: "invalid_value",
          message: `Contrast pair "${pair.foregroundTokenKey}" on "${pair.backgroundTokenKey}" must use a finite minimum ratio from ${requiredRatio}:1 to 21:1 for ${pair.usage ?? "normal_text"}`,
          tokenKey: pair.foregroundTokenKey,
        });
        continue;
      }
      const minRatio = pair.minimumRatio ?? requiredRatio;

      if (fgToken === undefined) {
        addFailure({
          code: "BROKEN_TOKEN_REFERENCE",
          family: "broken_reference",
          message: `Contrast pair references missing foreground token "${pair.foregroundTokenKey}"`,
          tokenKey: pair.foregroundTokenKey,
        });
        continue;
      }
      if (bgToken === undefined) {
        addFailure({
          code: "BROKEN_TOKEN_REFERENCE",
          family: "broken_reference",
          message: `Contrast pair references missing background token "${pair.backgroundTokenKey}"`,
          tokenKey: pair.backgroundTokenKey,
        });
        continue;
      }
      if (fgToken.kind !== "color_pair") {
        addFailure({
          code: "INVALID_TOKEN_KIND",
          family: "invalid_value",
          message: `Foreground token "${pair.foregroundTokenKey}" in contrast pair must be of kind "color_pair", found "${fgToken.kind}"`,
          tokenKey: pair.foregroundTokenKey,
        });
        continue;
      }
      if (bgToken.kind !== "color_pair") {
        addFailure({
          code: "INVALID_TOKEN_KIND",
          family: "invalid_value",
          message: `Background token "${pair.backgroundTokenKey}" in contrast pair must be of kind "color_pair", found "${bgToken.kind}"`,
          tokenKey: pair.backgroundTokenKey,
        });
        continue;
      }

      const lightRatio = contrastRatio(fgToken.light, bgToken.light, lightSurface);
      if (lightRatio < minRatio) {
        addFailure({
          code: "INSUFFICIENT_CONTRAST",
          family: "invalid_value",
          message: `Contrast pair "${pair.foregroundTokenKey}" on "${pair.backgroundTokenKey}" has insufficient light mode contrast ratio (${lightRatio.toFixed(2)}:1 < ${minRatio}:1)`,
          tokenKey: pair.foregroundTokenKey,
        });
      }
      const darkRatio = contrastRatio(fgToken.dark, bgToken.dark, darkSurface);
      if (darkRatio < minRatio) {
        addFailure({
          code: "INSUFFICIENT_CONTRAST",
          family: "invalid_value",
          message: `Contrast pair "${pair.foregroundTokenKey}" on "${pair.backgroundTokenKey}" has insufficient dark mode contrast ratio (${darkRatio.toFixed(2)}:1 < ${minRatio}:1)`,
          tokenKey: pair.foregroundTokenKey,
        });
      }
    }
  }

  return { failures, ruleFailures };
}
