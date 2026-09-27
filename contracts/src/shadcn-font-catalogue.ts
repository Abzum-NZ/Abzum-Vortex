import catalogue from "./catalogue/shadcn-fonts.generated.json";

/**
 * The shadcn/create font catalogue `tooling/emit-font-assets.mjs` generated from the pinned shadcn
 * preset: every font shadcn/create offers, each self-hosted from the Vortex origin with its licence.
 * Application theme selections name a body font and a heading font from it; the theme resolution
 * writes the selected fonts into the `body` and `heading` typography tokens, and the renderer links
 * only the stylesheets of the fonts those tokens name.
 */
export type ShadcnFont = Readonly<{
  /** The shadcn/create font id, for example `inter` or `source-sans-3`. */
  id: string;
  label: string;
  /** The CSS family name the font's stylesheet declares. */
  family: string;
  /** The Fontsource category: `sans-serif`, `serif`, `monospace`, `display` or `handwriting`. */
  category: string;
  /** The pinned package the font files and licence were taken from. */
  package: string;
  packageVersion: string;
  licence: string;
  /** The font's stylesheet, relative to where the application serves fonts. */
  stylesheet: string;
  /** The Latin face a page preloads, relative to where the application serves fonts. */
  preload: string;
}>;

export type ShadcnFontCatalogue = Readonly<{
  schemaVersion: string;
  registry: Readonly<{ package: string; packageVersion: string }>;
  defaults: Readonly<{ bodyFont: string; headingFont: string }>;
  /** The heading font option that paints headings in the body font. */
  headingInherit: string;
  fonts: readonly ShadcnFont[];
}>;

export const shadcnFontCatalogue = catalogue as ShadcnFontCatalogue;

/** Every catalogue font, in the pinned preset's order. */
export const shadcnFonts: readonly ShadcnFont[] = shadcnFontCatalogue.fonts;

/** The heading font option that paints headings in the selected body font. */
export const SHADCN_HEADING_FONT_INHERIT = shadcnFontCatalogue.headingInherit;

/** One catalogue font by its shadcn/create id, or undefined when the catalogue does not offer it. */
export const findShadcnFont = (id: string): ShadcnFont | undefined =>
  shadcnFonts.find((font) => font.id === id);

const requireFont = (id: string): ShadcnFont => {
  const font = findShadcnFont(id);
  if (font === undefined)
    throw new Error(`The font catalogue does not offer its own default "${id}"`);
  return font;
};

/** The pinned preset's default body font, which a selection that names none paints with. */
export const DEFAULT_SHADCN_BODY_FONT: ShadcnFont = requireFont(
  shadcnFontCatalogue.defaults.bodyFont,
);

/** The pinned preset's default heading font option (`inherit`: the body font). */
export const DEFAULT_SHADCN_HEADING_FONT: string = shadcnFontCatalogue.defaults.headingFont;

/**
 * Typography tokens name their family by builder key (lowercase words joined by underscores), so a
 * catalogue font's family key is its id with underscores: `source-sans-3` is `source_sans_3`.
 */
export const shadcnFontFamilyKey = (font: ShadcnFont): string => font.id.replace(/-/g, "_");

/** The catalogue font a typography token's family key names, or undefined for any other family. */
export const findShadcnFontByFamilyKey = (familyKey: string): ShadcnFont | undefined =>
  shadcnFonts.find((font) => shadcnFontFamilyKey(font) === familyKey);

const CATEGORY_FALLBACKS: Readonly<Record<string, string>> = {
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", serif',
  monospace: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
};
const SANS_FALLBACK =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

/**
 * The CSS font-family stack for one catalogue font: its self-hosted family first, then local
 * system fonts of the same category while it loads or when a glyph is outside its subsets.
 */
export const shadcnFontStack = (font: ShadcnFont): string =>
  `"${font.family}", ${CATEGORY_FALLBACKS[font.category] ?? SANS_FALLBACK}`;

/**
 * The body and heading fonts a selection paints with. An absent body font is the catalogue default;
 * an absent heading font is the default heading option; `inherit` paints headings in the body font.
 * Unknown ids resolve to the defaults here; the theme resolution refuses them before this is used.
 */
export const resolveShadcnFontSelection = (
  selection?: Readonly<{ bodyFont?: string | undefined; headingFont?: string | undefined }>,
): Readonly<{ body: ShadcnFont; heading: ShadcnFont }> => {
  const body = findShadcnFont(selection?.bodyFont ?? "") ?? DEFAULT_SHADCN_BODY_FONT;
  const headingOption = selection?.headingFont ?? DEFAULT_SHADCN_HEADING_FONT;
  const heading =
    headingOption === SHADCN_HEADING_FONT_INHERIT ? body : (findShadcnFont(headingOption) ?? body);
  return { body, heading };
};
