import "server-only";

import {
  resolveTheme,
  resolveThemeTokens,
  type ApplicationThemeV2,
  type ResolvedTheme,
  type ThemeResolutionOptions,
  type ThemeTokenValueV2,
} from "@vortex/theme";

/**
 * Resolves the deterministic final application theme for runtime and preview.
 * Rejects insufficient contrast, hidden focus, and unapproved assets.
 */
export function resolveApplicationTheme(
  theme: ApplicationThemeV2,
  options?: ThemeResolutionOptions | undefined,
): ResolvedTheme {
  return resolveTheme(theme, undefined, options);
}

/**
 * Resolves the deterministic final application theme tokens for runtime and preview.
 */
export function resolveApplicationThemeTokens(
  theme: ApplicationThemeV2,
  options?: ThemeResolutionOptions | undefined,
): Readonly<Record<string, ThemeTokenValueV2>> {
  return resolveThemeTokens(theme, undefined, options);
}
