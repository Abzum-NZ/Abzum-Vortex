import "server-only";
import { STUDIO_THEME_SELECTION } from "../definition/application-composition/theme";
import { DEFAULT_PLATFORM_THEME_RELEASE } from "./platform-theme-catalogue";
import { resolveThemeSelection } from "./selection";

const resolution = resolveThemeSelection({
  base: DEFAULT_PLATFORM_THEME_RELEASE,
  baseTokens: DEFAULT_PLATFORM_THEME_RELEASE.tokens,
  selection: STUDIO_THEME_SELECTION,
});
if (!resolution.valid) {
  console.error("[theme] Studio theme resolution failed", resolution.failures);
  throw new Error("STUDIO_THEME_RESOLUTION_FAILED");
}

/** Resolved once; the web layer projects this data into UI root props without an upward dependency. */
export const STUDIO_THEME_ROOT = resolution.resolved;
