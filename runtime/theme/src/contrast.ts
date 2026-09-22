import "server-only";

import type { DefinitionRuleFailure } from "@vortex/contracts";
import { createLocatedFailure } from "./errors";
import type {
  ThemeResolutionOptions,
  ThemeTokenValueV2,
  ThemeValidationFailure,
} from "./types";

export const WCAG_AA_NORMAL_TEXT_MIN_CONTRAST = 4.5;
export const WCAG_AA_LARGE_TEXT_MIN_CONTRAST = 3.0;
export const WCAG_AA_NON_TEXT_MIN_CONTRAST = 3.0;

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

export function findThemeSurface(
  tokens: Readonly<Record<string, ThemeTokenValueV2>>,
): Readonly<{ key?: string; light: string; dark: string; name: string }> {
  const colorEntries = Object.keys(tokens)
    .sort()
    .flatMap((key) => {
      const token = tokens[key];
      return token?.kind === "color_pair" ? [[key, token] as const] : [];
    });
  const exactPriority = ["background", "canvas", "surface", "bg", "page_background", "app_background"];
  const selected =
    exactPriority.flatMap((candidate) =>
      colorEntries.filter(([key]) => key.toLowerCase() === candidate),
    )[0] ?? colorEntries.find(([key]) => isBackgroundTokenKey(key));
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

function isBackgroundTokenKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower === "background" ||
    lower === "canvas" ||
    lower === "surface" ||
    lower === "bg" ||
    lower === "page_background" ||
    lower === "app_background" ||
    lower.endsWith("_background") ||
    lower.endsWith("_bg") ||
    lower.endsWith("_surface") ||
    lower.endsWith("_canvas")
  );
}

function isTextTokenKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower === "text" ||
    lower === "foreground" ||
    lower === "body" ||
    lower === "heading" ||
    lower === "label" ||
    lower === "caption" ||
    lower === "title" ||
    lower.endsWith("_text") ||
    lower.endsWith("_foreground")
  );
}

function isBrandOrPrimaryTokenKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower === "brand" ||
    lower === "primary" ||
    lower === "secondary" ||
    lower === "accent" ||
    lower === "action" ||
    lower.endsWith("_brand") ||
    lower.endsWith("_primary")
  );
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

  const surface = findThemeSurface(tokens);
  const lightSurface = surface.light;
  const darkSurface = surface.dark;
  const surfaceName = surface.name;
  const pairedForegroundKeys = new Set<string>();
  for (const key of Object.keys(tokens).sort()) {
    const token = tokens[key];
    if (token?.kind !== "color_pair") continue;
    const suffixPair = tokens[`${key}_foreground`];
    if (suffixPair?.kind === "color_pair") pairedForegroundKeys.add(`${key}_foreground`);
    const prefixPair = tokens[`on_${key}`];
    if (prefixPair?.kind === "color_pair") pairedForegroundKeys.add(`on_${key}`);
  }

  // Validate text & brand color pairs against surface
  for (const key of Object.keys(tokens).sort()) {
    const token = tokens[key];
    if (token === undefined) continue;
    if (token.kind !== "color_pair") continue;
    if (key === surface.key) continue;

    // A paired foreground is evaluated against its declared companion below. It
    // need not also contrast with the application surface on which it is not used.
    if (isTextTokenKey(key) && !pairedForegroundKeys.has(key)) {
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
    } else if (isBrandOrPrimaryTokenKey(key)) {
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

    // Check paired tokens: e.g. "brand" and "brand_foreground"
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

    // Check paired tokens: e.g. "on_primary" vs "primary"
    const onKey = `on_${key}`;
    const pairedOn = tokens[onKey];
    if (pairedOn !== undefined && pairedOn.kind === "color_pair") {
      const lightRatio = contrastRatio(pairedOn.light, token.light, lightSurface);
      if (lightRatio < WCAG_AA_NORMAL_TEXT_MIN_CONTRAST) {
        addFailure({
          code: "INSUFFICIENT_CONTRAST",
          family: "invalid_value",
          message: `Paired color token "${onKey}" has insufficient light mode contrast ratio (${lightRatio.toFixed(2)}:1 < ${WCAG_AA_NORMAL_TEXT_MIN_CONTRAST}:1) against "${key}"`,
          tokenKey: onKey,
        });
      }
      const darkRatio = contrastRatio(pairedOn.dark, token.dark, darkSurface);
      if (darkRatio < WCAG_AA_NORMAL_TEXT_MIN_CONTRAST) {
        addFailure({
          code: "INSUFFICIENT_CONTRAST",
          family: "invalid_value",
          message: `Paired color token "${onKey}" has insufficient dark mode contrast ratio (${darkRatio.toFixed(2)}:1 < ${WCAG_AA_NORMAL_TEXT_MIN_CONTRAST}:1) against "${key}"`,
          tokenKey: onKey,
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
