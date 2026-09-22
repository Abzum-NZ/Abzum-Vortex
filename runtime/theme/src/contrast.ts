import "server-only";

import type { DefinitionRuleFailure } from "@vortex/contracts";
import { createLocatedFailure } from "./errors";
import type {
  ColorPairToken,
  ContrastPairDeclaration,
  ThemeResolutionOptions,
  ThemeTokenValueV2,
  ThemeValidationFailure,
} from "./types";

export const WCAG_AA_NORMAL_TEXT_MIN_CONTRAST = 4.5;
export const WCAG_AA_LARGE_TEXT_MIN_CONTRAST = 3.0;
export const WCAG_AA_NON_TEXT_MIN_CONTRAST = 3.0;

const DEFAULT_LIGHT_SURFACE = "#FFFFFF";
const DEFAULT_DARK_SURFACE = "#000000";

function parseHex(hex: string): { r: number; g: number; b: number } {
  const clean = hex.startsWith("#") ? hex.slice(1) : hex;
  if (clean.length === 3) {
    const r = parseInt(clean[0]! + clean[0]!, 16);
    const g = parseInt(clean[1]! + clean[1]!, 16);
    const b = parseInt(clean[2]! + clean[2]!, 16);
    return { r, g, b };
  }
  if (clean.length === 6) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return { r, g, b };
  }
  throw new Error(`Invalid hex color: "${hex}"`);
}

function channelLuminance(channel: number): number {
  const sRGB = channel / 255;
  return sRGB <= 0.04045 ? sRGB / 12.92 : Math.pow((sRGB + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

export function contrastRatio(colorA: string, colorB: string): number {
  const lumA = relativeLuminance(colorA);
  const lumB = relativeLuminance(colorB);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
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

  // Find explicit or default background token
  let backgroundToken: ColorPairToken | undefined;
  let backgroundTokenKey: string | undefined;

  for (const [key, token] of Object.entries(tokens)) {
    if (token.kind === "color_pair" && isBackgroundTokenKey(key)) {
      backgroundToken = token;
      backgroundTokenKey = key;
      break;
    }
  }

  const lightSurface = backgroundToken?.light ?? DEFAULT_LIGHT_SURFACE;
  const darkSurface = backgroundToken?.dark ?? DEFAULT_DARK_SURFACE;
  const surfaceName = backgroundTokenKey ?? "default surface";

  // Validate text & brand color pairs against surface
  for (const [key, token] of Object.entries(tokens)) {
    if (token.kind !== "color_pair") continue;
    if (key === backgroundTokenKey) continue;

    if (isTextTokenKey(key)) {
      const lightRatio = contrastRatio(token.light, lightSurface);
      if (lightRatio < WCAG_AA_NORMAL_TEXT_MIN_CONTRAST) {
        addFailure({
          code: "INSUFFICIENT_CONTRAST",
          family: "invalid_value",
          message: `Text color token "${key}" has insufficient light mode contrast ratio (${lightRatio.toFixed(2)}:1 < ${WCAG_AA_NORMAL_TEXT_MIN_CONTRAST}:1) against ${surfaceName} (${lightSurface})`,
          tokenKey: key,
        });
      }
      const darkRatio = contrastRatio(token.dark, darkSurface);
      if (darkRatio < WCAG_AA_NORMAL_TEXT_MIN_CONTRAST) {
        addFailure({
          code: "INSUFFICIENT_CONTRAST",
          family: "invalid_value",
          message: `Text color token "${key}" has insufficient dark mode contrast ratio (${darkRatio.toFixed(2)}:1 < ${WCAG_AA_NORMAL_TEXT_MIN_CONTRAST}:1) against ${surfaceName} (${darkSurface})`,
          tokenKey: key,
        });
      }
    } else if (isBrandOrPrimaryTokenKey(key)) {
      const lightRatio = contrastRatio(token.light, lightSurface);
      if (lightRatio < WCAG_AA_NON_TEXT_MIN_CONTRAST) {
        addFailure({
          code: "INSUFFICIENT_CONTRAST",
          family: "invalid_value",
          message: `Brand color token "${key}" has insufficient light mode contrast ratio (${lightRatio.toFixed(2)}:1 < ${WCAG_AA_NON_TEXT_MIN_CONTRAST}:1) against ${surfaceName} (${lightSurface})`,
          tokenKey: key,
        });
      }
      const darkRatio = contrastRatio(token.dark, darkSurface);
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
      const lightRatio = contrastRatio(pairedForeground.light, token.light);
      if (lightRatio < WCAG_AA_NORMAL_TEXT_MIN_CONTRAST) {
        addFailure({
          code: "INSUFFICIENT_CONTRAST",
          family: "invalid_value",
          message: `Paired color token "${foregroundKey}" has insufficient light mode contrast ratio (${lightRatio.toFixed(2)}:1 < ${WCAG_AA_NORMAL_TEXT_MIN_CONTRAST}:1) against "${key}"`,
          tokenKey: foregroundKey,
        });
      }
      const darkRatio = contrastRatio(pairedForeground.dark, token.dark);
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
      const lightRatio = contrastRatio(pairedOn.light, token.light);
      if (lightRatio < WCAG_AA_NORMAL_TEXT_MIN_CONTRAST) {
        addFailure({
          code: "INSUFFICIENT_CONTRAST",
          family: "invalid_value",
          message: `Paired color token "${onKey}" has insufficient light mode contrast ratio (${lightRatio.toFixed(2)}:1 < ${WCAG_AA_NORMAL_TEXT_MIN_CONTRAST}:1) against "${key}"`,
          tokenKey: onKey,
        });
      }
      const darkRatio = contrastRatio(pairedOn.dark, token.dark);
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
      const minRatio = pair.minimumRatio ?? WCAG_AA_NORMAL_TEXT_MIN_CONTRAST;

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

      const lightRatio = contrastRatio(fgToken.light, bgToken.light);
      if (lightRatio < minRatio) {
        addFailure({
          code: "INSUFFICIENT_CONTRAST",
          family: "invalid_value",
          message: `Contrast pair "${pair.foregroundTokenKey}" on "${pair.backgroundTokenKey}" has insufficient light mode contrast ratio (${lightRatio.toFixed(2)}:1 < ${minRatio}:1)`,
          tokenKey: pair.foregroundTokenKey,
        });
      }
      const darkRatio = contrastRatio(fgToken.dark, bgToken.dark);
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
