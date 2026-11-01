import {
  applicationThemeSelectionSchema,
  platformThemeReleaseSchema,
  type ApplicationThemeSelection,
  type PlatformThemeRelease,
} from "../definition/application-composition/theme";
import { platformThemeReleaseContentHash } from "../definition/catalogue-release-content-hashes";
import source from "../catalogue/catalogue/platform-theme-catalogue.source.json";

const deepFreeze = <Value>(value: Value): Value => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
};

/**
 * One registered platform theme release: a source definition plus its canonical-JSON content hash,
 * computed once as the catalogue loads. It is parsed through the release contract and deep-frozen.
 */
const release = (definition: {
  catalogueThemeId: string;
  releaseVersion: string;
  tokens: unknown;
}): PlatformThemeRelease =>
  deepFreeze(
    platformThemeReleaseSchema.parse({
      catalogueThemeId: definition.catalogueThemeId,
      releaseVersion: definition.releaseVersion,
      ...platformThemeReleaseContentHash(definition),
      tokens: definition.tokens,
    }),
  );

/**
 * The one theme set the platform ships: the owner's Sera Mist preset (the default) and four
 * modern themes that differ in surface, accent, radius and type. Each is a complete
 * light-and-dark token set, so an interface can paint from it without a selection.
 */
export const PLATFORM_THEME_RELEASES = Object.freeze({
  sera_mist: release(source.PLATFORM_THEME_RELEASE_3_1_0),
  mira_slate: release(source.PLATFORM_THEME_MIRA_SLATE),
  lyra_sand: release(source.PLATFORM_THEME_LYRA_SAND),
  vega_ink: release(source.PLATFORM_THEME_VEGA_INK),
  maia_clay: release(source.PLATFORM_THEME_MAIA_CLAY),
});

/**
 * The registered platform theme release every platform interface and every new Studio
 * application starts from: the owner's preset b7D4CRcLg, with its Style part in the selection.
 */
export const DEFAULT_PLATFORM_THEME_RELEASE: PlatformThemeRelease =
  PLATFORM_THEME_RELEASES.sera_mist;

// The one theme changes in place. Applications pinning older content must be republished.
const DEFAULT_PLATFORM_THEME_CONTENT_FINGERPRINT =
  "sha256:44c62cf6e0865b7bbbea64431fa5e70f69ef27b86f34c878015fc0cf6ecca38f";

if (
  DEFAULT_PLATFORM_THEME_RELEASE.contentFingerprint !== DEFAULT_PLATFORM_THEME_CONTENT_FINGERPRINT
)
  throw new Error("Platform theme content fingerprint does not match its committed pin");

export type PlatformThemePreset = Readonly<{
  key: keyof typeof PLATFORM_THEME_RELEASES;
  label: string;
  description: string;
  release: PlatformThemeRelease;
  selection: ApplicationThemeSelection;
}>;

const preset = (
  key: PlatformThemePreset["key"],
  label: string,
  description: string,
  selection: ApplicationThemeSelection,
): PlatformThemePreset => ({
  key,
  label,
  description,
  release: PLATFORM_THEME_RELEASES[key],
  selection: applicationThemeSelectionSchema.parse(selection),
});

/** The theme set in the order Studio offers it: the owner's default first, then the modern themes. */
export const PLATFORM_THEME_PRESETS: readonly PlatformThemePreset[] = Object.freeze([
  preset("sera_mist", "Sera Mist", "The platform default: flat corners, Mist greys, Inter.", {
    style: "sera",
    baseColor: "mist",
    theme: "mist",
    chartColor: "mist",
    radius: "none",
    menuColor: "default",
    menuAccent: "subtle",
    iconLibrary: "lucide",
    bodyFont: "inter",
    headingFont: "inter",
  }),
  preset("mira_slate", "Mira Slate", "Compact, small corners, cool stone with blue accents.", {
    style: "mira",
    baseColor: "stone",
    theme: "blue",
    chartColor: "blue",
    radius: "small",
    menuColor: "default",
    menuAccent: "bold",
    iconLibrary: "lucide",
    bodyFont: "geist",
    headingFont: "geist",
  }),
  preset("lyra_sand", "Lyra Sand", "Warm sand, large corners, amber accents and a serif pairing.", {
    style: "lyra",
    baseColor: "taupe",
    theme: "amber",
    chartColor: "amber",
    radius: "large",
    menuColor: "default-translucent",
    menuAccent: "subtle",
    iconLibrary: "lucide",
    bodyFont: "source-sans-3",
    headingFont: "lora",
  }),
  preset("vega_ink", "Vega Ink", "Dark menu, medium corners, grey surfaces and violet accents.", {
    style: "vega",
    baseColor: "gray",
    theme: "violet",
    chartColor: "violet",
    radius: "medium",
    menuColor: "inverted",
    menuAccent: "bold",
    iconLibrary: "lucide",
    bodyFont: "manrope",
    headingFont: "manrope",
  }),
  preset(
    "maia_clay",
    "Maia Clay",
    "Olive surfaces, emerald accents, medium corners and display type.",
    {
      style: "maia",
      baseColor: "olive",
      theme: "emerald",
      chartColor: "emerald",
      radius: "medium",
      menuColor: "default",
      menuAccent: "subtle",
      iconLibrary: "lucide",
      bodyFont: "inter",
      headingFont: "playfair-display",
    },
  ),
]);

/** One registered platform theme release by its pin, or undefined when the pin names none. */
export const findPlatformThemeRelease = (pin: {
  catalogueThemeId: string;
  releaseVersion: string;
}): PlatformThemeRelease | undefined =>
  Object.values(PLATFORM_THEME_RELEASES).find(
    (candidate) =>
      candidate.catalogueThemeId === pin.catalogueThemeId &&
      candidate.releaseVersion === pin.releaseVersion,
  );

/** Whether a pin names one of the platform theme releases the catalogue ships. */
export const isRegisteredPlatformThemeRelease = (pin: {
  catalogueThemeId: string;
  releaseVersion: string;
}): boolean => findPlatformThemeRelease(pin) !== undefined;
