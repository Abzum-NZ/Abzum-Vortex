import options from "../catalogue/catalogue/shadcn-font-options.json";

/** Small browser-safe view of each font's identity and CSS fallback data. */
export type ShadcnFontOption = Readonly<{
  id: string;
  family: string;
  category: string;
}>;

type ShadcnFontOptionsDocument = Readonly<{
  defaults: Readonly<{ bodyFont: string; headingFont: string }>;
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

const defaultBody = findShadcnFont(fontOptions.defaults.bodyFont);
if (defaultBody === undefined)
  throw new Error(`Font options omit their default body font "${fontOptions.defaults.bodyFont}"`);

/** Default body and heading fonts used by the current platform theme release. */
export const resolveShadcnFontSelection = (
  selection?: Readonly<{ bodyFont?: string | undefined; headingFont?: string | undefined }>,
): Readonly<{ body: ShadcnFontOption; heading: ShadcnFontOption }> => {
  const body = findShadcnFont(selection?.bodyFont ?? "") ?? defaultBody;
  const headingOption = selection?.headingFont ?? fontOptions.defaults.headingFont;
  const heading =
    headingOption === SHADCN_HEADING_FONT_INHERIT ? body : (findShadcnFont(headingOption) ?? body);
  return { body, heading };
};
