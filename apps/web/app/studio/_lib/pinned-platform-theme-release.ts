import { PLATFORM_THEME_RELEASE_3_1_0 } from "@vortex/platform/server";

/** The platform theme release a draft's theme pin names, or undefined when the pin names none. */
export function findPinnedPlatformThemeRelease(pin: {
  catalogue_theme_id: string;
  release_version: string;
}) {
  const release = PLATFORM_THEME_RELEASE_3_1_0;
  return release.catalogueThemeId === pin.catalogue_theme_id &&
    release.releaseVersion === pin.release_version
    ? release
    : undefined;
}
