import "server-only";

import type { BuilderKey, NamespacedKey } from "@vortex/contracts";
import {
  resolveTheme,
  resolveThemeTokens,
  type ApplicationThemeV2,
  type ResolvedTheme,
  type ThemeTokenKindV2,
  type ThemeResolutionOptions,
  type ThemeTokenValueV2,
} from "@vortex/theme";

export type PlacementThemeResolutionContext = Readonly<{
  themeOverrides?: Readonly<Record<string, ThemeTokenValueV2>> | undefined;
  permittedTokenKinds?: ReadonlySet<ThemeTokenKindV2> | readonly ThemeTokenKindV2[] | undefined;
  pageKey?: BuilderKey | undefined;
  componentKey?: NamespacedKey | undefined;
  placementAlias?: BuilderKey | undefined;
}>;

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
  placement: PlacementThemeResolutionContext,
  options?: ThemeResolutionOptions | undefined,
): Readonly<Record<string, ThemeTokenValueV2>> {
  return resolveThemeTokens(
    theme,
    {
      overrides: placement.themeOverrides,
      permittedTokenKinds: placement.permittedTokenKinds,
      pageKey: placement.pageKey,
      componentKey: placement.componentKey,
      placementAlias: placement.placementAlias,
    },
    options,
  );
}
