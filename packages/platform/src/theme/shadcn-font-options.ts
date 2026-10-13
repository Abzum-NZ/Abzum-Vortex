import options from "../catalogue/catalogue/shadcn-font-options.json";

/** Small browser-safe view of each font's identity and CSS fallback data. */
export type ShadcnFontOption = Readonly<{
  id: string;
  family: string;
  category: string;
}>;

type ShadcnFontOptionsDocument = Readonly<{
  headingInherit: string;
  fonts: readonly ShadcnFontOption[];
}>;

const fontOptions = options as ShadcnFontOptionsDocument;

/** The catalogue font options shipped to renderers, without package or licence metadata. */
export const shadcnFontOptions: readonly ShadcnFontOption[] = fontOptions.fonts;

export const SHADCN_HEADING_FONT_INHERIT = fontOptions.headingInherit;

/** One font option by its id, or undefined when the id is not offered. */
export const findShadcnFont = (id: string): ShadcnFontOption | undefined =>
  shadcnFontOptions.find((font) => font.id === id);

/** Typography tokens use a builder key derived from a font id's hyphenated words. */
export const shadcnFontFamilyKey = (font: ShadcnFontOption): string => font.id.replace(/-/g, "_");

/** The catalogue font a typography token's family key names, or undefined for any other family. */
export const findShadcnFontByFamilyKey = (familyKey: string): ShadcnFontOption | undefined =>
  shadcnFontOptions.find((font) => shadcnFontFamilyKey(font) === familyKey);

const CATEGORY_FALLBACKS: Readonly<Record<string, string>> = {
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", serif',
  monospace: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
};
const SANS_FALLBACK =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

/** The CSS stack for one font, then local system fonts from its category. */
export const shadcnFontStack = (font: ShadcnFontOption): string =>
  `"${font.family}", ${CATEGORY_FALLBACKS[font.category] ?? SANS_FALLBACK}`;

/** The body and heading fonts a selection paints with; `inherit` paints headings in the body font. */
export const resolveShadcnFontSelection = (
  selection: Readonly<{ bodyFont: string; headingFont: string }>,
): Readonly<{ body: ShadcnFontOption; heading: ShadcnFontOption }> => {
  const requireFont = (id: string): ShadcnFontOption => {
    const font = findShadcnFont(id);
    if (font === undefined) throw new Error(`The font options do not offer "${id}"`);
    return font;
  };
  const body = requireFont(selection.bodyFont);
  const heading =
    selection.headingFont === SHADCN_HEADING_FONT_INHERIT ? body : requireFont(selection.headingFont);
  return { body, heading };
};
