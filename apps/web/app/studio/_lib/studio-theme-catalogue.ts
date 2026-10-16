import "server-only";

import { SHADCN_HEADING_FONT_INHERIT, SHADCN_ICON_LIBRARIES, shadcnFontOptions } from "@vortex/platform/schema";
import {
  findShadcnThemeRelease,
  shadcnThemeCatalogueOptions,
  type ShadcnThemeCatalogueDimensionKey,
} from "@vortex/platform/server";
import type { StudioThemeDimension, StudioThemeOption, StudioThemeOptions } from "./studio-theme-options";

const iconLibraryLabels: Readonly<Record<(typeof SHADCN_ICON_LIBRARIES)[number], string>> = {
  lucide: "Lucide", hugeicons: "Hugeicons", tabler: "Tabler", phosphor: "Phosphor", remixicon: "Remix Icon",
};

/** The token a colour option's swatch shows. */
const swatchTokens: Partial<Record<ShadcnThemeCatalogueDimensionKey, string>> = {
  baseColor: "muted_text", theme: "primary", chartColor: "chart_3",
};

const catalogueOptions = (dimension: ShadcnThemeCatalogueDimensionKey): readonly StudioThemeOption[] =>
  shadcnThemeCatalogueOptions(dimension)
    .filter((option) => option.release?.refused !== true)
    .map((option) => {
      const token = swatchTokens[dimension];
      const release = token === undefined || option.releaseKey === undefined ? undefined : findShadcnThemeRelease(option.releaseKey);
      const value = token === undefined ? undefined : release?.tokens[token] as { kind?: string; light?: string; dark?: string } | undefined;
      if (token !== undefined && (value?.kind !== "color_pair" || value.light === undefined || value.dark === undefined))
        throw new Error(`The shadcn catalogue option ${dimension}:${option.id} has no ${token} colour for its swatch`);
      return {
        id: option.id,
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
        ...(value === undefined ? {} : { swatch: { light: value.light!, dark: value.dark! } }),
      };
    });

/** A font's name as people know it: the catalogue family without its variable-font suffix. */
const fontLabel = (family: string) => family.replace(/ Variable$/, "");
const fonts: readonly StudioThemeOption[] = shadcnFontOptions.map((font) => ({ id: font.id, label: fontLabel(font.family) }));

const dimensions: readonly StudioThemeDimension[] = [
  { key: "style", label: "Style", hint: "Spacing, shape and type scale of every component.", options: catalogueOptions("style") },
  { key: "base_color", label: "Base colour", hint: "The neutral colours of backgrounds, borders and text.", options: catalogueOptions("baseColor") },
  { key: "theme", label: "Theme", hint: "The brand colour of buttons, links and highlights.", options: catalogueOptions("theme") },
  { key: "chart_color", label: "Chart colour", hint: "The colours charts draw their series in.", options: catalogueOptions("chartColor") },
  { key: "heading_font", label: "Heading font", hint: "The font of titles and headings.",
    options: [{ id: SHADCN_HEADING_FONT_INHERIT, label: "Same as the font" }, ...fonts] },
  { key: "body_font", label: "Font", hint: "The font of all other text.", options: fonts },
  { key: "icon_library", label: "Icon library", hint: "The set every icon in the application is drawn from.",
    options: SHADCN_ICON_LIBRARIES.map((id) => ({ id, label: iconLibraryLabels[id] })) },
  { key: "radius", label: "Radius", hint: "How rounded corners are.", options: catalogueOptions("radius") },
  { key: "menu_color", label: "Menu", hint: "The colour of the application menu.", options: catalogueOptions("menuColor") },
  { key: "menu_accent", label: "Menu accent", hint: "How the current menu entry stands out.", options: catalogueOptions("menuAccent") },
];

/** The Theme tab's options, from the checked-in shadcn 4.21.0 catalogue. */
export const studioThemeOptions: StudioThemeOptions = { dimensions };
