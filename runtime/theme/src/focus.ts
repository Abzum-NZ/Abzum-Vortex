import "server-only";

import type { DefinitionRuleFailure } from "@vortex/contracts";
import { contrastRatio, WCAG_AA_NON_TEXT_MIN_CONTRAST } from "./contrast";
import { createLocatedFailure } from "./errors";
import type {
  ColorPairToken,
  ThemeResolutionOptions,
  ThemeTokenValueV2,
  ThemeValidationFailure,
} from "./types";

const DEFAULT_LIGHT_SURFACE = "#FFFFFF";
const DEFAULT_DARK_SURFACE = "#000000";

const MINIMUM_VISIBLE_FOCUS_WIDTH_REM = 0.0625; // 1px at 16px base

function findSurface(tokens: Readonly<Record<string, ThemeTokenValueV2>>): {
  light: string;
  dark: string;
  name: string;
} {
  for (const [key, token] of Object.entries(tokens)) {
    if (
      token.kind === "color_pair" &&
      (key === "background" ||
        key === "surface" ||
        key === "canvas" ||
        key === "bg" ||
        key.endsWith("_background") ||
        key.endsWith("_surface"))
    ) {
      return { light: token.light, dark: token.dark, name: key };
    }
  }
  return {
    light: DEFAULT_LIGHT_SURFACE,
    dark: DEFAULT_DARK_SURFACE,
    name: "default surface",
  };
}

export function validateFocusVisibility(
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

  const surface = findSurface(tokens);

  for (const [key, token] of Object.entries(tokens)) {
    // Validate focus tokens
    if (token.kind === "focus") {
      // 1. Width must be non-zero and visible
      if (token.widthRem <= 0 || token.widthRem < MINIMUM_VISIBLE_FOCUS_WIDTH_REM) {
        addFailure({
          code: "HIDDEN_FOCUS",
          family: "unsafe_content",
          message: `Focus token "${key}" has hidden focus: widthRem (${token.widthRem}) must be at least ${MINIMUM_VISIBLE_FOCUS_WIDTH_REM}rem to ensure visible focus`,
          tokenKey: key,
        });
      }

      // 2. Color token reference must exist and be color_pair
      const colorToken = tokens[token.colorToken];
      if (colorToken === undefined) {
        addFailure({
          code: "BROKEN_TOKEN_REFERENCE",
          family: "broken_reference",
          message: `Focus token "${key}" references missing color token "${token.colorToken}"`,
          tokenKey: key,
        });
        continue;
      }
      if (colorToken.kind !== "color_pair") {
        addFailure({
          code: "INVALID_TOKEN_KIND",
          family: "broken_reference",
          message: `Focus token "${key}" references non-color token "${token.colorToken}" of kind "${colorToken.kind}"`,
          tokenKey: key,
        });
        continue;
      }

      // 3. Contrast of focus color against surface
      const colorPair = colorToken as ColorPairToken;
      const lightRatio = contrastRatio(colorPair.light, surface.light);
      if (lightRatio < WCAG_AA_NON_TEXT_MIN_CONTRAST) {
        addFailure({
          code: "HIDDEN_FOCUS",
          family: "unsafe_content",
          message: `Focus token "${key}" has hidden focus: light mode color "${colorPair.light}" has insufficient contrast ratio (${lightRatio.toFixed(2)}:1 < ${WCAG_AA_NON_TEXT_MIN_CONTRAST}:1) against ${surface.name} (${surface.light})`,
          tokenKey: key,
        });
      }

      const darkRatio = contrastRatio(colorPair.dark, surface.dark);
      if (darkRatio < WCAG_AA_NON_TEXT_MIN_CONTRAST) {
        addFailure({
          code: "HIDDEN_FOCUS",
          family: "unsafe_content",
          message: `Focus token "${key}" has hidden focus: dark mode color "${colorPair.dark}" has insufficient contrast ratio (${darkRatio.toFixed(2)}:1 < ${WCAG_AA_NON_TEXT_MIN_CONTRAST}:1) against ${surface.name} (${surface.dark})`,
          tokenKey: key,
        });
      }
    }

    // Validate border tokens reference valid color_pairs
    if (token.kind === "border") {
      const colorToken = tokens[token.colorToken];
      if (colorToken === undefined) {
        addFailure({
          code: "BROKEN_TOKEN_REFERENCE",
          family: "broken_reference",
          message: `Border token "${key}" references missing color token "${token.colorToken}"`,
          tokenKey: key,
        });
      } else if (colorToken.kind !== "color_pair") {
        addFailure({
          code: "INVALID_TOKEN_KIND",
          family: "broken_reference",
          message: `Border token "${key}" references non-color token "${token.colorToken}" of kind "${colorToken.kind}"`,
          tokenKey: key,
        });
      }
    }
  }

  return { failures, ruleFailures };
}
