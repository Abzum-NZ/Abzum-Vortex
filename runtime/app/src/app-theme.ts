import "server-only";

import {
  resolveTheme,
  resolveThemeTokens,
  validateApplicationTheme,
  type ApplicationThemeV2,
  type ResolvedTheme,
  type ThemeResolutionOptions,
  type ThemeTokenValueV2,
  type ThemeValidationResult,
} from "@vortex/theme";

export { validateApplicationTheme, type ThemeValidationResult };

/**
 * Validates an application theme and returns a structured ThemeValidationResult.
 */
export function validateApplicationThemeDefinition(
  theme: ApplicationThemeV2,
  options?: ThemeResolutionOptions | undefined,
): ThemeValidationResult {
  return validateApplicationTheme(theme, options);
}

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
