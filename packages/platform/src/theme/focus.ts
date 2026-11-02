import "server-only";

import type { DefinitionRuleFailure } from "../catalogue/validation-errors";
import {
  contrastRatio,
  DEFAULT_DARK_SURFACE,
  DEFAULT_LIGHT_SURFACE,
  findThemeSurface,
  WCAG_AA_NON_TEXT_MIN_CONTRAST,
} from "./contrast";
import { createLocatedFailure } from "./errors";
import type { ThemeResolutionOptions, ThemeTokenValue, ThemeValidationFailure } from "./types";

/** The fills a focused control commonly sits on, besides the page background. */
const FOCUS_SURFACE_KEYS = ["card", "popover", "muted", "accent", "secondary", "sidebar"] as const;

const MINIMUM_VISIBLE_FOCUS_WIDTH_REM = 0.0625; // 1px at 16px base

export function validateFocusVisibility(
  tokens: Readonly<Record<string, ThemeTokenValue>>,
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
  let foundFocusToken = false;

  for (const key of Object.keys(tokens).sort()) {
    const token = tokens[key];
    if (token === undefined) continue;
    // Validate focus tokens
    if (token.kind === "focus") {
      foundFocusToken = true;
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

      // 3. Contrast of the focus colour against the page surface and every surface a focused control
      // can sit on: the focus outline is the only focus indicator, so it must read on all of them.
      const surfaces = [
        { key: surface.key, name: surface.name, light: surface.light, dark: surface.dark },
        ...FOCUS_SURFACE_KEYS.flatMap((surfaceKey) => {
          const candidate = tokens[surfaceKey];
          return candidate?.kind === "color_pair" && surfaceKey !== surface.key
            ? [{ key: surfaceKey, name: surfaceKey, light: candidate.light, dark: candidate.dark }]
            : [];
        }),
      ];
      for (const target of surfaces) {
        const lightRatio = contrastRatio(colorToken.light, target.light, DEFAULT_LIGHT_SURFACE);
        if (lightRatio < WCAG_AA_NON_TEXT_MIN_CONTRAST) {
          addFailure({
            code: "HIDDEN_FOCUS",
            family: "unsafe_content",
            message: `Focus token "${key}" has hidden focus: light mode color "${colorToken.light}" has insufficient contrast ratio (${lightRatio.toFixed(2)}:1 < ${WCAG_AA_NON_TEXT_MIN_CONTRAST}:1) against ${target.name} (${target.light})`,
            tokenKey: key,
          });
        }
        const darkRatio = contrastRatio(colorToken.dark, target.dark, DEFAULT_DARK_SURFACE);
        if (darkRatio < WCAG_AA_NON_TEXT_MIN_CONTRAST) {
          addFailure({
            code: "HIDDEN_FOCUS",
            family: "unsafe_content",
            message: `Focus token "${key}" has hidden focus: dark mode color "${colorToken.dark}" has insufficient contrast ratio (${darkRatio.toFixed(2)}:1 < ${WCAG_AA_NON_TEXT_MIN_CONTRAST}:1) against ${target.name} (${target.dark})`,
            tokenKey: key,
          });
        }
      }
    }
  }

  if (!foundFocusToken) {
    addFailure({
      code: "MISSING_FOCUS_TOKEN",
      family: "unsafe_content",
      message: "The resolved application theme must declare a visible focus appearance",
    });
  }

  return { failures, ruleFailures };
}
