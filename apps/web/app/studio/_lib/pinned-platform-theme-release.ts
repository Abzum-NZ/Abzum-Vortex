import { findPlatformThemeRelease } from "@vortex/platform/server";

/** The platform theme release a draft's theme pin names, or undefined when the pin names none. */
export function findPinnedPlatformThemeRelease(pin: {
  catalogue_theme_id: string;
  release_version: string;
}) {
  return findPlatformThemeRelease({
    catalogueThemeId: pin.catalogue_theme_id,
    releaseVersion: pin.release_version,
  });
}
