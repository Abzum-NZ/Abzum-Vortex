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
 * Resolves the deterministic theme tokens for an application page.
 */
export function resolvePageTheme(
  theme: ApplicationThemeV2,
  options?: ThemeResolutionOptions | undefined,
): ResolvedTheme {
  return resolveTheme(theme, undefined, options);
}

/**
 * Resolves the deterministic final theme tokens for a specific placement on a page,
 * applying its component-level theme overrides.
 */
export function resolvePlacementThemeTokens(
  theme: ApplicationThemeV2,
  placement: Readonly<{ themeOverrides?: Readonly<Record<string, ThemeTokenValueV2>> | undefined }>,
  options?: ThemeResolutionOptions | undefined,
): Readonly<Record<string, ThemeTokenValueV2>> {
  return resolveThemeTokens(theme, placement.themeOverrides, options);
}
