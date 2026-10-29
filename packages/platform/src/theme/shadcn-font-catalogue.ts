import catalogue from "../catalogue/catalogue/shadcn-fonts.json";

/**
 * The checked-in shadcn/create font catalogue: every font shadcn/create offers at the pinned version, with
 * the pinned package and licence each one came from. Application theme selections name a body
 * font and a heading font from it; the theme resolution writes the selected fonts into the `body`
 * and `heading` typography tokens, and the theme bridge (packages/ui/src/theme/theme-variables.ts) turns
 * the family a token names into a CSS variable for the renderer to paint with.
 */
type ShadcnFont = Readonly<{
  /** The shadcn/create font id, for example `inter` or `source-sans-3`. */
  id: string;
  label: string;
  /** The CSS family name the font's own stylesheet declares. */
  family: string;
  /** The Fontsource category: `sans-serif`, `serif`, `monospace`, `display` or `handwriting`. */
  category: string;
  /** The pinned package the font files and licence were taken from. */
  package: string;
  packageVersion: string;
  licence: string;
}>;

type ShadcnFontCatalogue = Readonly<{
  schemaVersion: string;
  registry: Readonly<{ package: string; packageVersion: string }>;
  defaults: Readonly<{ bodyFont: string; headingFont: string }>;
  /** The heading font option that paints headings in the body font. */
  headingInherit: string;
  fonts: readonly ShadcnFont[];
}>;

const shadcnFontCatalogue = catalogue as ShadcnFontCatalogue;

/** Every catalogue font, in the pinned preset's order. */
const shadcnFonts: readonly ShadcnFont[] = shadcnFontCatalogue.fonts;

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

/**
 * Typography tokens name their family by builder key (lowercase words joined by underscores), so a
 * catalogue font's family key is its id with underscores: `source-sans-3` is `source_sans_3`.
 */
export const shadcnFontFamilyKey = (font: ShadcnFont): string => font.id.replace(/-/g, "_");

/**
 * The body and heading fonts a selection paints with; `inherit` paints headings in the body font.
 * The theme resolution refuses unknown ids before this is used.
 */
export const resolveShadcnFontSelection = (
  selection: Readonly<{ bodyFont: string; headingFont: string }>,
): Readonly<{ body: ShadcnFont; heading: ShadcnFont }> => {
  const body = requireFont(selection.bodyFont);
  const heading =
    selection.headingFont === SHADCN_HEADING_FONT_INHERIT
      ? body
      : requireFont(selection.headingFont);
  return { body, heading };
};
