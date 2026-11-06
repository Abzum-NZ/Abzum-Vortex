import "server-only";

import { resolvedApplicationThemeSchema } from "../definition/application-composition/theme";
import { findPlatformThemeRelease } from "./platform-theme-catalogue";
import { resolveThemeSelection } from "./selection";
import {
  effectiveThemeSelection,
  organizationThemeSelectionSchema,
  type OrganizationThemeSelection,
} from "./organization-theme-selection";
import type { ApplicationTheme, StoredApplicationTheme } from "./types";

const RESOLVED_THEME_LIMIT = 64;
const resolvedThemes = new Map<string, ApplicationTheme>();

/**
 * The one function that resolves the theme an interface is drawn with, for every surface: an
 * application page, Studio's chrome, the canvas and portals. Per dimension the application's own
 * choice wins, else the organisation's value, else the platform's. The selection is then resolved
 * over the current catalogue release the theme pins by identity, so a catalogue change reaches
 * every application on its next page load and no release holds tokens. A selection that no longer
 * resolves fails loudly: an application is never drawn in a theme nobody chose. The result is a
 * pure function of the catalogue and the effective selection, so it is remembered per selection.
 */
export const resolveApplicationTheme = (
  theme: StoredApplicationTheme,
  organization: OrganizationThemeSelection | undefined,
): ApplicationTheme => {
  const selection = effectiveThemeSelection(
    theme.selection,
    organization === undefined ? undefined : organizationThemeSelectionSchema.parse(organization),
  );
  const key = JSON.stringify([theme.base.catalogueThemeId, theme.base.releaseVersion, selection]);
  const known = resolvedThemes.get(key);
  if (known !== undefined) return known;
  const release = findPlatformThemeRelease(theme.base);
  if (release === undefined) throw new Error("APPLICATION_THEME_BASE_RELEASE_UNKNOWN");
  const resolution = resolveThemeSelection({
    base: release,
    baseTokens: release.tokens,
    selection,
  });
  if (!resolution.valid) {
    console.error(
      "[theme] the selection does not resolve over the pinned platform theme",
      resolution.failures.map((failure) => `${failure.code}:${failure.tokenKey ?? ""}`).slice(0, 8),
    );
    throw new Error("APPLICATION_THEME_RESOLUTION_FAILED");
  }
  const resolved = Object.freeze(
    resolvedApplicationThemeSchema.parse({
      base: theme.base,
      selection: resolution.resolved.selection,
      tokens: resolution.resolved.tokens,
    }),
  );
  if (resolvedThemes.size >= RESOLVED_THEME_LIMIT)
    resolvedThemes.delete(resolvedThemes.keys().next().value!);
  resolvedThemes.set(key, resolved);
  return resolved;
};
