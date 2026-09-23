import type { CSSProperties } from "react";
import type { ApplicationThemeV2, ThemeTokenValueV2 } from "@vortex/contracts";
import {
  extractThemeTokens,
  generateThemeCssVariables,
  generateThemeCssVariableStyle,
  sanitizeCssIdentifier,
  type ThemeCssVariableMap,
  type ThemeMode,
} from "./theme-variables";

export type ThemeStyleProps = Readonly<{
  style: CSSProperties;
  "data-vortex-theme": string;
  "data-vortex-theme-mode": ThemeMode;
}>;

/**
 * Creates standard HTML / React props to mount resolved theme CSS variables onto
 * a runtime or preview container element.
 *
 * Both runtime pages and preview canvases receive identical CSS-variable styling
 * with readable light/dark mode selection.
 */
export function createThemeStyleProps(
  themeOrTokens: ApplicationThemeV2 | Readonly<Record<string, ThemeTokenValueV2>> | undefined,
  mode: ThemeMode = "light",
): ThemeStyleProps {
  if (themeOrTokens === undefined) {
    return {
      style: {} as CSSProperties,
      "data-vortex-theme": "app",
      "data-vortex-theme-mode": mode,
    };
  }

  const style = generateThemeCssVariableStyle(themeOrTokens, mode);
  return {
    style,
    "data-vortex-theme": "app",
    "data-vortex-theme-mode": mode,
  };
}

/**
 * Computes localized inline CSSProperties for placement-level theme overrides.
 *
 * When a placement declares theme overrides, these variables are mounted on the
 * placement's container element, naturally cascading to its child tree without
 * modifying or re-rendering outside elements.
 */
export function computePlacementThemeStyle(
  overrides?: Readonly<Record<string, ThemeTokenValueV2>> | undefined,
  mode: ThemeMode = "light",
): CSSProperties | undefined {
  if (!overrides || Object.keys(overrides).length === 0) {
    return undefined;
  }

  const result: Record<`--${string}`, string> = {};
  const sortedKeys = Object.keys(overrides).sort();

  for (const key of sortedKeys) {
    const token = overrides[key];
    if (token === undefined) continue;
    const cssKey = sanitizeCssIdentifier(key);

    switch (token.kind) {
      case "color_pair": {
        const activeColor = mode === "dark" ? token.dark : token.light;
        result[`--vortex-color-${cssKey}`] = activeColor;
        result[`--vortex-color-${cssKey}-light`] = token.light;
        result[`--vortex-color-${cssKey}-dark`] = token.dark;
        if (cssKey === "primary" || cssKey === "brand") {
          result["--vortex-color-primary"] = activeColor;
          result["--vortex-color-primary-hover"] = activeColor;
        } else if (cssKey === "primary-foreground" || cssKey === "on-primary") {
          result["--vortex-color-primary-foreground"] = activeColor;
        } else if (cssKey === "surface" || cssKey === "background") {
          result["--vortex-surface"] = activeColor;
        } else if (cssKey === "foreground" || cssKey === "text") {
          result["--vortex-foreground"] = activeColor;
        } else if (cssKey === "border") {
          result["--vortex-color-border"] = activeColor;
        }
        break;
      }
      case "typography": {
        result[`--vortex-font-family-${cssKey}`] = token.family;
        result[`--vortex-font-size-${cssKey}`] = `${token.sizeRem}rem`;
        result[`--vortex-line-height-${cssKey}`] = String(token.lineHeight);
        result[`--vortex-font-weight-${cssKey}`] = String(token.weight);
        break;
      }
      case "spacing": {
        result[`--vortex-spacing-${cssKey}`] = `${token.rem}rem`;
        break;
      }
      case "corners": {
        result[`--vortex-radius-${cssKey}`] = `${token.rem}rem`;
        break;
      }
      case "border": {
        const colorIdent = sanitizeCssIdentifier(token.colorToken);
        const colorVar = `var(--vortex-color-${colorIdent}, var(--vortex-color-border))`;
        result[`--vortex-border-width-${cssKey}`] = `${token.widthRem}rem`;
        result[`--vortex-border-style-${cssKey}`] = token.style;
        result[`--vortex-border-color-${cssKey}`] = colorVar;
        result[`--vortex-border-${cssKey}`] = `${token.widthRem}rem ${token.style} ${colorVar}`;
        break;
      }
      case "focus": {
        const colorIdent = sanitizeCssIdentifier(token.colorToken);
        const colorVar = `var(--vortex-color-${colorIdent}, var(--vortex-color-focus))`;
        const safeWidthRem = Math.max(token.widthRem, 0.0625);
        result[`--vortex-focus-width-${cssKey}`] = `${safeWidthRem}rem`;
        result[`--vortex-focus-color-${cssKey}`] = colorVar;
        result[`--vortex-focus-outline-${cssKey}`] = `${safeWidthRem}rem solid ${colorVar}`;
        result[`--vortex-focus-ring-${cssKey}`] = `0 0 0 ${safeWidthRem}rem ${colorVar}`;
        break;
      }
      case "elevation": {
        // Handled via standard elevation level conversion
        break;
      }
      case "density": {
        const isCompact = token.value === "compact";
        result["--vortex-density"] = token.value;
        result["--vortex-density-control-padding-y"] = isCompact ? "0.375rem" : "0.5rem";
        result["--vortex-density-control-padding-x"] = isCompact ? "0.625rem" : "0.75rem";
        result["--vortex-density-control-min-height"] = isCompact ? "2rem" : "2.5rem";
        break;
      }
      case "asset":
        break;
    }
  }

  return Object.keys(result).length > 0 ? (result as unknown as CSSProperties) : undefined;
}

/**
 * Merges placement overrides into a base token dictionary deterministically.
 */
export function mergeThemeOverrides(
  baseTokens: Readonly<Record<string, ThemeTokenValueV2>>,
  overrides?: Readonly<Record<string, ThemeTokenValueV2>> | undefined,
): Readonly<Record<string, ThemeTokenValueV2>> {
  if (!overrides || Object.keys(overrides).length === 0) {
    return baseTokens;
  }
  const merged = { ...baseTokens, ...overrides };
  const sorted: Record<string, ThemeTokenValueV2> = {};
  for (const key of Object.keys(merged).sort()) {
    const val = merged[key];
    if (val !== undefined) sorted[key] = val;
  }
  return Object.freeze(sorted);
}

/**
 * Resolves theme CSS variables for a specific theme mode.
 */
export function resolveThemeVariablesForMode(
  themeOrTokens: ApplicationThemeV2 | Readonly<Record<string, ThemeTokenValueV2>>,
  mode: ThemeMode,
): ThemeCssVariableMap {
  return generateThemeCssVariables(themeOrTokens, mode);
}
