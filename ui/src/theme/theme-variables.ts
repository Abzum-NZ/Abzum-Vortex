import type { CSSProperties } from "react";
import type { ApplicationThemeV2, ThemeTokenValueV2 } from "@vortex/contracts";

export type ThemeMode = "light" | "dark";

export type ThemeCssVariableMap = Readonly<Record<`--${string}`, string>>;

/**
 * Sanitizes a token key into a safe, bounded CSS custom property identifier segment.
 * Accepts only letters, digits, underscores, and hyphens. Strips illegal characters.
 */
export function sanitizeCssIdentifier(raw: string): string {
  const sanitized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/_+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "default";
}

/**
 * Converts an integer elevation level (0..N) to a deterministic box-shadow string.
 */
function elevationLevelToBoxShadow(level: number): string {
  switch (level) {
    case 0:
      return "none";
    case 1:
      return "0 1px 2px 0 rgba(0, 0, 0, 0.05)";
    case 2:
      return "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1)";
    case 3:
      return "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1)";
    case 4:
      return "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)";
    default:
      return "0 25px 50px -12px rgba(0, 0, 0, 0.25)";
  }
}

/**
 * Canonical fallback CSS variables for light appearance.
 * All contrast pairs exceed WCAG 2.2 AA (normal text >= 4.5:1, non-text/focus >= 3.0:1).
 */
export const DEFAULT_THEME_VARIABLES_LIGHT: ThemeCssVariableMap = Object.freeze({
  "--vortex-surface": "#ffffff",
  "--vortex-surface-secondary": "#f9fafb",
  "--vortex-surface-tertiary": "#f3f4f6",
  "--vortex-foreground": "#111827",
  "--vortex-foreground-muted": "#52615b",
  "--vortex-color-primary": "#10211b",
  "--vortex-color-primary-foreground": "#ffffff",
  "--vortex-color-primary-hover": "#1d382f",
  "--vortex-color-primary-subtle": "rgba(16, 33, 27, 0.06)",
  "--vortex-color-secondary": "#f3f4f6",
  "--vortex-color-secondary-foreground": "#1f2937",
  "--vortex-color-border": "rgba(16, 33, 27, 0.18)",
  "--vortex-color-border-hover": "#52615b",
  "--vortex-color-focus": "#2563eb",
  "--vortex-color-danger": "#dc2626",
  "--vortex-color-danger-foreground": "#ffffff",
  "--vortex-color-danger-surface": "#fef2f2",
  "--vortex-color-danger-border": "#fca5a5",
  "--vortex-color-warning": "#d97706",
  "--vortex-color-warning-foreground": "#78350f",
  "--vortex-color-warning-surface": "#fffbeb",
  "--vortex-color-warning-border": "#fde68a",
  "--vortex-color-info": "#2563eb",
  "--vortex-color-info-foreground": "#ffffff",
  "--vortex-color-info-surface": "#eff6ff",
  "--vortex-color-info-border": "#bfdbfe",
  "--vortex-color-disabled-surface": "#f3f4f6",
  "--vortex-color-disabled-foreground": "#9ca3af",
  "--vortex-color-disabled-border": "#e5e7eb",
});

/**
 * Canonical fallback CSS variables for dark appearance.
 * All contrast pairs exceed WCAG 2.2 AA (normal text >= 4.5:1, non-text/focus >= 3.0:1).
 */
export const DEFAULT_THEME_VARIABLES_DARK: ThemeCssVariableMap = Object.freeze({
  "--vortex-surface": "#121816",
  "--vortex-surface-secondary": "#1a2420",
  "--vortex-surface-tertiary": "#24322d",
  "--vortex-foreground": "#f3f0e8",
  "--vortex-foreground-muted": "#9db0a8",
  "--vortex-color-primary": "#d7ff54",
  "--vortex-color-primary-foreground": "#10211b",
  "--vortex-color-primary-hover": "#c5f03d",
  "--vortex-color-primary-subtle": "rgba(215, 255, 84, 0.12)",
  "--vortex-color-secondary": "#24322d",
  "--vortex-color-secondary-foreground": "#f3f0e8",
  "--vortex-color-border": "rgba(243, 240, 232, 0.22)",
  "--vortex-color-border-hover": "#9db0a8",
  "--vortex-color-focus": "#60a5fa",
  "--vortex-color-danger": "#f87171",
  "--vortex-color-danger-foreground": "#121816",
  "--vortex-color-danger-surface": "#450a0a",
  "--vortex-color-danger-border": "#991b1b",
  "--vortex-color-warning": "#fbbf24",
  "--vortex-color-warning-foreground": "#121816",
  "--vortex-color-warning-surface": "#451a03",
  "--vortex-color-warning-border": "#b45309",
  "--vortex-color-info": "#60a5fa",
  "--vortex-color-info-foreground": "#121816",
  "--vortex-color-info-surface": "#172554",
  "--vortex-color-info-border": "#1e40af",
  "--vortex-color-disabled-surface": "#1a2420",
  "--vortex-color-disabled-foreground": "#657770",
  "--vortex-color-disabled-border": "rgba(243, 240, 232, 0.12)",
});

/**
 * Common layout, typography, spacing, border, elevation, and density variables.
 */
export const DEFAULT_THEME_VARIABLES_COMMON: ThemeCssVariableMap = Object.freeze({
  "--vortex-font-family": 'Arial, Helvetica, system-ui, -apple-system, sans-serif',
  "--vortex-font-size": "1rem",
  "--vortex-line-height": "1.5",
  "--vortex-font-weight": "400",
  "--vortex-font-family-heading": 'Arial, Helvetica, system-ui, -apple-system, sans-serif',
  "--vortex-font-size-heading": "1.5rem",
  "--vortex-line-height-heading": "1.25",
  "--vortex-font-weight-heading": "700",
  "--vortex-font-family-mono": 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  "--vortex-spacing-xs": "0.25rem",
  "--vortex-spacing-sm": "0.5rem",
  "--vortex-spacing-md": "1rem",
  "--vortex-spacing-lg": "1.5rem",
  "--vortex-spacing-xl": "2rem",
  "--vortex-spacing-2xl": "3rem",
  "--vortex-radius-none": "0px",
  "--vortex-radius-sm": "0.125rem",
  "--vortex-radius-md": "0.25rem",
  "--vortex-radius-lg": "0.5rem",
  "--vortex-radius-full": "9999px",
  "--vortex-radius": "0.25rem",
  "--vortex-border-width": "0.0625rem",
  "--vortex-border-style": "solid",
  "--vortex-border": "0.0625rem solid var(--vortex-color-border)",
  "--vortex-focus-width": "0.1875rem",
  "--vortex-focus-offset": "0.125rem",
  "--vortex-focus-outline": "0.1875rem solid var(--vortex-color-focus)",
  "--vortex-focus-ring": "0 0 0 0.1875rem var(--vortex-color-focus)",
  "--vortex-elevation-none": "none",
  "--vortex-elevation-low": "0 1px 2px 0 rgba(0, 0, 0, 0.05)",
  "--vortex-elevation-medium": "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1)",
  "--vortex-elevation-high": "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1)",
  "--vortex-density": "comfortable",
  "--vortex-density-control-padding-y": "0.5rem",
  "--vortex-density-control-padding-x": "0.75rem",
  "--vortex-density-control-min-height": "2.5rem",
  "--vortex-density-cell-padding-y": "0.625rem",
  "--vortex-density-cell-padding-x": "0.875rem",
});

/**
 * Extracts raw tokens from an ApplicationThemeV2 or token map.
 */
export function extractThemeTokens(
  themeOrTokens: ApplicationThemeV2 | Readonly<Record<string, ThemeTokenValueV2>>,
): Readonly<Record<string, ThemeTokenValueV2>> {
  if ("tokens" in themeOrTokens && typeof themeOrTokens.tokens === "object" && themeOrTokens.tokens !== null) {
    return themeOrTokens.tokens;
  }
  return themeOrTokens as Readonly<Record<string, ThemeTokenValueV2>>;
}

/**
 * Generates a complete, bounded CSS-variable map from resolved #594 theme tokens.
 *
 * Covers typography, color, spacing, borders, focus, elevation and density.
 * Evaluates color pairs according to the requested mode ("light", "dark", or mode-independent).
 * Always preserves visible focus with minimum 1px / 0.0625rem width and high-contrast outline.
 *
 * Application definitions cannot supply arbitrary CSS strings, class names or scripts.
 */
export function generateThemeCssVariables(
  themeOrTokens: ApplicationThemeV2 | Readonly<Record<string, ThemeTokenValueV2>>,
  mode?: ThemeMode,
): ThemeCssVariableMap {
  const tokens = extractThemeTokens(themeOrTokens);
  const result: Record<`--${string}`, string> = {};

  // 1. Seed with common and mode fallbacks
  Object.assign(result, DEFAULT_THEME_VARIABLES_COMMON);
  if (mode === "dark") {
    Object.assign(result, DEFAULT_THEME_VARIABLES_DARK);
  } else {
    Object.assign(result, DEFAULT_THEME_VARIABLES_LIGHT);
  }

  // 2. Iterate sorted tokens for determinism
  const tokenKeys = Object.keys(tokens).sort();
  for (const key of tokenKeys) {
    const token = tokens[key];
    if (token === undefined) continue;
    const cssKey = sanitizeCssIdentifier(key);

    switch (token.kind) {
      case "color_pair": {
        // Mode-specific color values
        result[`--vortex-color-${cssKey}-light`] = token.light;
        result[`--vortex-color-${cssKey}-dark`] = token.dark;
        const activeColor = mode === "dark" ? token.dark : token.light;
        result[`--vortex-color-${cssKey}`] = activeColor;

        // Semantic mappings
        if (
          cssKey === "surface" ||
          cssKey === "background" ||
          cssKey === "canvas" ||
          cssKey === "page-background"
        ) {
          result["--vortex-surface"] = activeColor;
        } else if (cssKey === "foreground" || cssKey === "text" || cssKey === "body") {
          result["--vortex-foreground"] = activeColor;
        } else if (cssKey === "primary" || cssKey === "brand") {
          result["--vortex-color-primary"] = activeColor;
          result["--vortex-color-primary-hover"] = activeColor;
        } else if (cssKey === "primary-foreground" || cssKey === "on-primary") {
          result["--vortex-color-primary-foreground"] = activeColor;
        } else if (cssKey === "secondary") {
          result["--vortex-color-secondary"] = activeColor;
        } else if (cssKey === "secondary-foreground" || cssKey === "on-secondary") {
          result["--vortex-color-secondary-foreground"] = activeColor;
        } else if (cssKey === "muted" || cssKey === "muted-foreground") {
          result["--vortex-foreground-muted"] = activeColor;
        } else if (cssKey === "border") {
          result["--vortex-color-border"] = activeColor;
        } else if (cssKey === "danger" || cssKey === "error") {
          result["--vortex-color-danger"] = activeColor;
        } else if (cssKey === "danger-foreground") {
          result["--vortex-color-danger-foreground"] = activeColor;
        } else if (cssKey === "warning") {
          result["--vortex-color-warning"] = activeColor;
        } else if (cssKey === "warning-foreground") {
          result["--vortex-color-warning-foreground"] = activeColor;
        } else if (cssKey === "info") {
          result["--vortex-color-info"] = activeColor;
        } else if (cssKey === "focus") {
          result["--vortex-color-focus"] = activeColor;
        }
        break;
      }

      case "typography": {
        result[`--vortex-font-family-${cssKey}`] = token.family;
        result[`--vortex-font-size-${cssKey}`] = `${token.sizeRem}rem`;
        result[`--vortex-line-height-${cssKey}`] = String(token.lineHeight);
        result[`--vortex-font-weight-${cssKey}`] = String(token.weight);

        if (cssKey === "body" || cssKey === "default" || cssKey === "text") {
          result["--vortex-font-family"] = token.family;
          result["--vortex-font-size"] = `${token.sizeRem}rem`;
          result["--vortex-line-height"] = String(token.lineHeight);
          result["--vortex-font-weight"] = String(token.weight);
        } else if (cssKey === "heading" || cssKey === "title") {
          result["--vortex-font-family-heading"] = token.family;
          result["--vortex-font-size-heading"] = `${token.sizeRem}rem`;
          result["--vortex-line-height-heading"] = String(token.lineHeight);
          result["--vortex-font-weight-heading"] = String(token.weight);
        } else if (cssKey === "mono" || cssKey === "code") {
          result["--vortex-font-family-mono"] = token.family;
        }
        break;
      }

      case "spacing": {
        result[`--vortex-spacing-${cssKey}`] = `${token.rem}rem`;
        if (cssKey === "md" || cssKey === "default") {
          result["--vortex-spacing-md"] = `${token.rem}rem`;
        }
        break;
      }

      case "corners": {
        result[`--vortex-radius-${cssKey}`] = `${token.rem}rem`;
        if (cssKey === "md" || cssKey === "default") {
          result["--vortex-radius"] = `${token.rem}rem`;
          result["--vortex-radius-md"] = `${token.rem}rem`;
        }
        break;
      }

      case "border": {
        const colorIdent = sanitizeCssIdentifier(token.colorToken);
        const colorVar = `var(--vortex-color-${colorIdent}, var(--vortex-color-border))`;
        result[`--vortex-border-width-${cssKey}`] = `${token.widthRem}rem`;
        result[`--vortex-border-style-${cssKey}`] = token.style;
        result[`--vortex-border-color-${cssKey}`] = colorVar;
        result[`--vortex-border-${cssKey}`] = `${token.widthRem}rem ${token.style} ${colorVar}`;

        if (cssKey === "default") {
          result["--vortex-border-width"] = `${token.widthRem}rem`;
          result["--vortex-border-style"] = token.style;
          result["--vortex-border"] = `${token.widthRem}rem ${token.style} ${colorVar}`;
        }
        break;
      }

      case "focus": {
        const colorIdent = sanitizeCssIdentifier(token.colorToken);
        const colorVar = `var(--vortex-color-${colorIdent}, var(--vortex-color-focus))`;
        // Enforce visible focus: minimum 1px / 0.0625rem
        const safeWidthRem = Math.max(token.widthRem, 0.0625);
        result[`--vortex-focus-width-${cssKey}`] = `${safeWidthRem}rem`;
        result[`--vortex-focus-color-${cssKey}`] = colorVar;
        result[`--vortex-focus-outline-${cssKey}`] = `${safeWidthRem}rem solid ${colorVar}`;
        result[`--vortex-focus-ring-${cssKey}`] = `0 0 0 ${safeWidthRem}rem ${colorVar}`;

        if (cssKey === "default" || !result["--vortex-focus-width"]) {
          result["--vortex-focus-width"] = `${safeWidthRem}rem`;
          result["--vortex-focus-color"] = colorVar;
          result["--vortex-focus-outline"] = `${safeWidthRem}rem solid ${colorVar}`;
          result["--vortex-focus-ring"] = `0 0 0 ${safeWidthRem}rem ${colorVar}`;
        }
        break;
      }

      case "elevation": {
        const shadow = elevationLevelToBoxShadow(token.level);
        result[`--vortex-elevation-${cssKey}`] = shadow;
        break;
      }

      case "density": {
        const isCompact = token.value === "compact";
        result["--vortex-density"] = token.value;
        result["--vortex-density-control-padding-y"] = isCompact ? "0.375rem" : "0.5rem";
        result["--vortex-density-control-padding-x"] = isCompact ? "0.625rem" : "0.75rem";
        result["--vortex-density-control-min-height"] = isCompact ? "2rem" : "2.5rem";
        result["--vortex-density-cell-padding-y"] = isCompact ? "0.375rem" : "0.625rem";
        result["--vortex-density-cell-padding-x"] = isCompact ? "0.5rem" : "0.875rem";
        break;
      }

      case "asset":
        // Assets are validated at publication and referenced by asset ID, not CSS properties
        break;
    }
  }

  return Object.freeze(result);
}

/**
 * Converts a theme CSS-variable map to React CSSProperties for inline application
 * in runtime and preview containers.
 */
export function generateThemeCssVariableStyle(
  themeOrTokens: ApplicationThemeV2 | Readonly<Record<string, ThemeTokenValueV2>>,
  mode?: ThemeMode,
): CSSProperties {
  const vars = generateThemeCssVariables(themeOrTokens, mode);
  return { ...vars } as unknown as CSSProperties;
}

/**
 * Generates scoped CSS rules declaring theme variables for runtime and preview.
 * Includes both light and dark mode selector blocks for live mode switching.
 */
export function generateThemeStylesheet(
  themeOrTokens: ApplicationThemeV2 | Readonly<Record<string, ThemeTokenValueV2>>,
  options?: { selector?: string },
): string {
  const selector = options?.selector ?? ":root, [data-vortex-theme]";
  const lightVars = generateThemeCssVariables(themeOrTokens, "light");
  const darkVars = generateThemeCssVariables(themeOrTokens, "dark");

  const serializeVars = (map: ThemeCssVariableMap): string =>
    Object.entries(map)
      .map(([prop, val]) => `  ${prop}: ${val};`)
      .join("\n");

  return `
/* Base & Light Mode Theme Variables */
${selector}, [data-vortex-theme-mode="light"] {
${serializeVars(lightVars)}
}

/* Dark Mode Theme Variables */
[data-vortex-theme-mode="dark"], .vortex-dark, .dark {
${serializeVars(darkVars)}
}

@media (prefers-color-scheme: dark) {
  ${selector}:not([data-vortex-theme-mode="light"]) {
${serializeVars(darkVars)}
  }
}
`.trim();
}
