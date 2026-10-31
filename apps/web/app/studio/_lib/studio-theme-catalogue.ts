import "server-only";

import {
  SHADCN_HEADING_FONT_INHERIT,
  SHADCN_ICON_LIBRARIES,
  shadcnFontOptions,
} from "@vortex/platform/schema";
import {
  findShadcnThemeRelease,
  PLATFORM_THEME_PRESETS,
  shadcnThemeCatalogueOptions,
  type PlatformThemeRelease,
  type ShadcnThemeCatalogueDimensionKey,
} from "@vortex/platform/server";
import type { SourceApplicationThemeSelection } from "@vortex/platform/schema";
import type {
  StudioThemeDimension,
  StudioThemeOption,
  StudioThemeOptions,
  StudioThemePreset,
} from "./studio-theme-options";

const iconLibraryLabels: Readonly<Record<(typeof SHADCN_ICON_LIBRARIES)[number], string>> = {
  lucide: "Lucide",
  hugeicons: "Hugeicons",
  tabler: "Tabler",
  phosphor: "Phosphor",
  remixicon: "Remix Icon",
};

/** The token a colour option's swatch shows. */
const swatchTokens: Partial<Record<ShadcnThemeCatalogueDimensionKey, string>> = {
  baseColor: "muted_text",
  theme: "primary",
  chartColor: "chart_3",
};

const catalogueOptions = (
  dimension: ShadcnThemeCatalogueDimensionKey,
): readonly StudioThemeOption[] =>
  shadcnThemeCatalogueOptions(dimension)
    .filter((option) => option.release?.refused !== true)
    .map((option) => {
      const token = swatchTokens[dimension];
      const release =
        token === undefined || option.releaseKey === undefined
          ? undefined
          : findShadcnThemeRelease(option.releaseKey);
      const value =
        token === undefined
          ? undefined
          : (release?.tokens[token] as
              { kind?: string; light?: string; dark?: string } | undefined);
      if (
        token !== undefined &&
        (value?.kind !== "color_pair" || value.light === undefined || value.dark === undefined)
      )
        throw new Error(
          `The shadcn catalogue option ${dimension}:${option.id} has no ${token} colour for its swatch`,
        );
      return {
        id: option.id,
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
        ...(value === undefined ? {} : { swatch: { light: value.light!, dark: value.dark! } }),
      };
    });

/** A font's name as people know it: the catalogue family without its variable-font suffix. */
const fontLabel = (family: string) => family.replace(/ Variable$/, "");
const fonts: readonly StudioThemeOption[] = shadcnFontOptions.map((font) => ({
  id: font.id,
  label: fontLabel(font.family),
}));

const colour = (release: PlatformThemeRelease, key: string, mode: "light" | "dark"): string => {
  const token = release.tokens[key] as { kind?: string; light?: string; dark?: string } | undefined;
  if (token?.kind !== "color_pair") throw new Error(`Platform theme has no colour ${key}`);
  return token[mode]!;
};

const sourceSelection = (
  selection: (typeof PLATFORM_THEME_PRESETS)[number]["selection"],
): SourceApplicationThemeSelection => ({
  style: selection.style,
  base_color: selection.baseColor,
  theme: selection.theme,
  chart_color: selection.chartColor,
  radius: selection.radius,
  menu_color: selection.menuColor,
  menu_accent: selection.menuAccent,
  icon_library: selection.iconLibrary,
  body_font: selection.bodyFont,
  heading_font: selection.headingFont,
});

/** The platform theme set as preview cards: each release's own surface, text, accent and badge. */
const themePresets: readonly StudioThemePreset[] = PLATFORM_THEME_PRESETS.map((entry) => ({
  key: entry.key,
  label: entry.label,
  description: entry.description,
  base: {
    catalogueThemeId: entry.release.catalogueThemeId,
    releaseVersion: entry.release.releaseVersion,
  },
  selection: sourceSelection(entry.selection),
  preview: {
    light: {
      background: colour(entry.release, "background", "light"),
      card: colour(entry.release, "card", "light"),
      text: colour(entry.release, "text", "light"),
      primary: colour(entry.release, "primary", "light"),
      primaryForeground: colour(entry.release, "primary_foreground", "light"),
    },
    dark: {
      background: colour(entry.release, "background", "dark"),
      card: colour(entry.release, "card", "dark"),
      text: colour(entry.release, "text", "dark"),
      primary: colour(entry.release, "primary", "dark"),
      primaryForeground: colour(entry.release, "primary_foreground", "dark"),
    },
  },
}));

const dimensions: readonly StudioThemeDimension[] = [
  {
    key: "style",
    label: "Style",
    hint: "Spacing, shape and type scale of every component.",
    options: catalogueOptions("style"),
  },
  {
    key: "base_color",
    label: "Base colour",
    hint: "The neutral colours of backgrounds, borders and text.",
    options: catalogueOptions("baseColor"),
  },
  {
    key: "theme",
    label: "Theme",
    hint: "The brand colour of buttons, links and highlights.",
    options: catalogueOptions("theme"),
  },
  {
    key: "chart_color",
    label: "Chart colour",
    hint: "The colours charts draw their series in.",
    options: catalogueOptions("chartColor"),
  },
  {
    key: "heading_font",
    label: "Heading font",
    hint: "The font of titles and headings.",
    options: [{ id: SHADCN_HEADING_FONT_INHERIT, label: "Same as the font" }, ...fonts],
  },
  { key: "body_font", label: "Font", hint: "The font of all other text.", options: fonts },
  {
    key: "icon_library",
    label: "Icon library",
    hint: "The set every icon in the application is drawn from.",
    options: SHADCN_ICON_LIBRARIES.map((id) => ({ id, label: iconLibraryLabels[id] })),
  },
  {
    key: "radius",
    label: "Radius",
    hint: "How rounded corners are.",
    options: catalogueOptions("radius"),
  },
  {
    key: "menu_color",
    label: "Menu",
    hint: "The colour of the application menu.",
    options: catalogueOptions("menuColor"),
  },
  {
    key: "menu_accent",
    label: "Menu accent",
    hint: "How the current menu entry stands out.",
    options: catalogueOptions("menuAccent"),
  },
];

/** The Theme tab's options, from the checked-in shadcn 4.21.0 catalogue. */
export const studioThemeOptions: StudioThemeOptions = { dimensions, presets: themePresets };
