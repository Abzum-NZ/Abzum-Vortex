import { PLATFORM_THEME_RELEASE_2_0_0, PLATFORM_THEME_RELEASE_3_0_0 } from "@vortex/platform/server";

/** The platform theme release a draft's theme pin names, or undefined when the pin names none. */
export function findPinnedPlatformThemeRelease(pin: { catalogue_theme_id: string; release_version: string }) {
  return [PLATFORM_THEME_RELEASE_2_0_0, PLATFORM_THEME_RELEASE_3_0_0].find((item) =>
    item.catalogueThemeId === pin.catalogue_theme_id && item.releaseVersion === pin.release_version);
}
