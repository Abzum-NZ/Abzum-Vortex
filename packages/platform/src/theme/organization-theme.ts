import "server-only";

import { applicationThemeSchema } from "../definition/application-composition/theme";
import { findPlatformThemeRelease } from "./platform-theme-catalogue";
import { resolveThemeSelection } from "./selection";
import {
  effectiveThemeSelection,
  organizationThemeSelectionSchema,
  type OrganizationThemeSelection,
} from "./organization-theme-selection";
import type { ApplicationTheme } from "./types";

/**
 * The theme an application is drawn with inside an organisation: its own theme where the
 * application chose a dimension, the organisation's value where it did not, the platform's
 * otherwise. The result is the application theme resolved over the application's pinned platform
 * release, so every consumer reads one theme format. A theme the organisation leaves unchanged
 * is returned as it is. An organisation theme that no longer resolves over the pinned release fails
 * loudly: the application is never drawn in a theme nobody chose.
 */
export const applyOrganizationTheme = (
  theme: ApplicationTheme,
  organization: OrganizationThemeSelection | undefined,
): ApplicationTheme => {
  if (organization === undefined) return theme;
  const parsed = organizationThemeSelectionSchema.parse(organization);
  const selection = effectiveThemeSelection(theme.selection, parsed);
  if (JSON.stringify(selection) === JSON.stringify(theme.selection)) return theme;
  const release = findPlatformThemeRelease(theme.base);
  if (release === undefined) throw new Error("ORGANIZATION_THEME_BASE_RELEASE_UNKNOWN");
  const resolution = resolveThemeSelection({
    base: release,
    baseTokens: release.tokens,
    selection,
  });
  if (!resolution.valid) {
    console.error(
      "[theme] the organisation theme does not resolve over the application's platform theme",
      resolution.failures.map((failure) => `${failure.code}:${failure.tokenKey ?? ""}`).slice(0, 8),
    );
    throw new Error("ORGANIZATION_THEME_RESOLUTION_FAILED");
  }
  return applicationThemeSchema.parse({
    base: theme.base,
    selection: resolution.resolved.selection,
    tokens: resolution.resolved.tokens,
  });
};
