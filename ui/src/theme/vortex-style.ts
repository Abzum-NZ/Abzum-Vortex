import type { ApplicationThemeSelectionV2 } from "@vortex/contracts";

/**
 * The shadcn/create visual styles the platform theme catalogue offers at the pinned shadcn version.
 * Each style ships as its own stylesheet (`tooling/emit-style-stylesheets.mjs` compiles the
 * catalogue's asset for every option here), scoped to `[data-vortex-style="<style>"]` on the root
 * element, so one component source serves every style and selecting a style needs no code change.
 */
export const VORTEX_STYLES = [
  "nova",
  "vega",
  "maia",
  "lyra",
  "mira",
  "luma",
  "sera",
  "rhea",
] as const;

export type VortexStyle = (typeof VORTEX_STYLES)[number];

/** The style a page paints with when the resolved selection names none that ships. */
export const DEFAULT_VORTEX_STYLE: VortexStyle = "nova";

/**
 * The menu treatments the catalogue offers. The catalogue carries each option as a shadcn variant
 * descriptor rather than a stylesheet, so the resolved value is published as a root attribute for
 * the menu styles to select with, never as generated CSS.
 */
export const VORTEX_MENU_COLORS = [
  "default",
  "inverted",
  "default-translucent",
  "inverted-translucent",
] as const;

export type VortexMenuColor = (typeof VORTEX_MENU_COLORS)[number];

export const DEFAULT_VORTEX_MENU_COLOR: VortexMenuColor = "default";

/** The menu accent effects the catalogue offers, published on the root as an attribute. */
export const VORTEX_MENU_ACCENTS = ["subtle", "bold"] as const;

export type VortexMenuAccent = (typeof VORTEX_MENU_ACCENTS)[number];

export const DEFAULT_VORTEX_MENU_ACCENT: VortexMenuAccent = "subtle";

/**
 * The one resolved selection the root attributes and the style stylesheet come from: the style id
 * when it is a shipped one, and the menu colour and accent when they are offered options. An
 * unknown or absent value resolves to that dimension's platform default, so a selection that
 * predates an option, or one the catalogue has since withdrawn, still paints a complete root.
 */
export type VortexStyleSelection = Readonly<{
  style: VortexStyle;
  menu: VortexMenuColor;
  menuAccent: VortexMenuAccent;
}>;

/** The root attributes the runtime page or preview canvas carries, beside `data-vortex-theme`. */
export type VortexStyleRootProps = Readonly<{
  "data-vortex-style": VortexStyle;
  "data-vortex-menu": VortexMenuColor;
  "data-vortex-menu-accent": VortexMenuAccent;
}>;

/**
 * Where the emitted style stylesheets are served from. `apps/web` publishes `public/` at the root,
 * so every application that renders the layout renderer publishes the emitted stylesheets here.
 */
export const VORTEX_STYLE_STYLESHEET_BASE_PATH = "/styles";

/**
 * The address of one style's emitted stylesheet. Only the resolved style is ever linked, so a page
 * loads exactly one style stylesheet and never the whole catalogue.
 */
export function vortexStyleStylesheetHref(style: VortexStyle): string {
  return `${VORTEX_STYLE_STYLESHEET_BASE_PATH}/${style}.css`;
}

/**
 * The style for the `data-vortex-style` root attribute: the resolved theme's style when it is a
 * shipped one, otherwise the platform default.
 */
export function resolveVortexStyle(requested?: string | null): VortexStyle {
  return VORTEX_STYLES.find((style) => style === requested) ?? DEFAULT_VORTEX_STYLE;
}

/** The menu colour the resolved selection names, or the platform default. */
export function resolveVortexMenuColor(requested?: string | null): VortexMenuColor {
  return VORTEX_MENU_COLORS.find((menu) => menu === requested) ?? DEFAULT_VORTEX_MENU_COLOR;
}

/** The menu accent the resolved selection names, or the platform default. */
export function resolveVortexMenuAccent(requested?: string | null): VortexMenuAccent {
  return VORTEX_MENU_ACCENTS.find((accent) => accent === requested) ?? DEFAULT_VORTEX_MENU_ACCENT;
}

/** The whole resolved selection, from the theme's catalogue selection or from nothing at all. */
export function resolveVortexStyleSelection(
  selection?: ApplicationThemeSelectionV2 | undefined,
): VortexStyleSelection {
  return {
    style: resolveVortexStyle(selection?.style),
    menu: resolveVortexMenuColor(selection?.menuColor),
    menuAccent: resolveVortexMenuAccent(selection?.menuAccent),
  };
}

/**
 * The style, menu and menu-accent attributes for one runtime page or preview canvas root. Reading
 * them from the theme the server resolved for this request is what keeps the style stylesheet and
 * the attribute that selects it in step: a page never paints one style under another's attribute.
 */
export function createVortexStyleRootProps(resolved: VortexStyleSelection): VortexStyleRootProps {
  return {
    "data-vortex-style": resolved.style,
    "data-vortex-menu": resolved.menu,
    "data-vortex-menu-accent": resolved.menuAccent,
  };
}
