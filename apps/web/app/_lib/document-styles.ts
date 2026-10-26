import "server-only";

import { createHash } from "node:crypto";
import STYLE_VARIANTS_CSS from "@vortex/ui/styles/style-variants.css?raw";
import { VORTEX_STYLES, type VortexStyle, type VortexStyleSheetHrefs } from "@vortex/ui/theme";
import { ALL_UI_STYLES_CSS } from "@vortex/ui/theme/styles";
import { PLATFORM_ROOT_CSS, STUDIO_ROOT_CSS } from "./document-theme";

const stylesheet = (name: string, css: string) => ({
  filename: `${name}-${createHash("sha256").update(css).digest("hex").slice(0, 16)}.css`,
  css,
});

/** Fixed styles are cacheable assets; request-specific theme variables stay on their roots. */
export const DOCUMENT_STYLESHEETS = {
  platform: stylesheet("platform", PLATFORM_ROOT_CSS),
  studio: stylesheet("studio", `${PLATFORM_ROOT_CSS}\n${STUDIO_ROOT_CSS}`),
  components: stylesheet("components", ALL_UI_STYLES_CSS),
};

/** The end of a block that opens at `open`, skipping comments and quoted strings. */
const blockEnd = (css: string, open: number): number => {
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    const character = css[index];
    if (character === "/" && css[index + 1] === "*") {
      const close = css.indexOf("*/", index + 2);
      if (close < 0) break;
      index = close + 1;
    } else if (character === '"' || character === "'") {
      const close = css.indexOf(character, index + 1);
      if (close < 0) break;
      index = close;
    } else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index + 1;
  }
  throw new Error(`Style variants stylesheet has an unclosed block at offset ${open}`);
};

/**
 * Each style's own component rules, in source order. Every top-level block of the style-variants
 * stylesheet is an `@scope` rule whose roots name the styles it belongs to; a block shared by
 * several styles belongs to each of them. The rules stay in the component layer, after the shared
 * component rules the document already links, exactly as when one stylesheet carried them all.
 */
const styleVariantStylesheets = (css: string): Partial<Record<VortexStyle, string>> => {
  const blocks = new Map<VortexStyle, string[]>();
  const gap = /(?:\s|\/\*[\s\S]*?\*\/)*/y;
  let index = 0;
  for (;;) {
    gap.lastIndex = index;
    gap.exec(css);
    index = gap.lastIndex;
    if (index >= css.length) break;
    if (!css.startsWith("@scope (", index))
      throw new Error(`Style variants stylesheet has a rule outside @scope at offset ${index}`);
    const open = css.indexOf("{", index);
    const roots = css.slice(index, open).split(") to (")[0] ?? "";
    const styles = [...roots.matchAll(/\[data-vortex-style="([a-z]+)"\]/g)].map(([, name]) => {
      const style = VORTEX_STYLES.find((candidate) => candidate === name);
      if (style === undefined) throw new Error(`Style variants stylesheet names unknown style ${name}`);
      return style;
    });
    if (styles.length === 0)
      throw new Error(`Style variants stylesheet has an @scope without a style at offset ${index}`);
    const end = blockEnd(css, open);
    for (const style of styles) blocks.set(style, [...(blocks.get(style) ?? []), css.slice(index, end)]);
    index = end;
  }
  return Object.fromEntries(
    [...blocks].map(([style, rules]) => [
      style,
      `@layer vortex-components {\n${rules.join("\n\n")}\n}\n`,
    ]),
  );
};

/** One cached stylesheet per style that has rules of its own, named after the style. */
const STYLE_STYLESHEETS = Object.fromEntries(
  Object.entries(styleVariantStylesheets(STYLE_VARIANTS_CSS)).map(([style, css]) => [
    style,
    stylesheet(style, css),
  ]),
) as Partial<Record<VortexStyle, ReturnType<typeof stylesheet>>>;

/** Every stylesheet the document styles route serves. */
export const SERVED_STYLESHEETS = [
  ...Object.values(DOCUMENT_STYLESHEETS),
  ...Object.values(STYLE_STYLESHEETS),
];

const href = (filename: string): string => `/api/document-styles/${filename}`;

export const documentStylesheetHref = (name: keyof typeof DOCUMENT_STYLESHEETS): string =>
  href(DOCUMENT_STYLESHEETS[name].filename);

/** The stylesheet of each style's own component rules, for the style roots that paint with it. */
export const STYLE_STYLESHEET_HREFS: VortexStyleSheetHrefs = Object.fromEntries(
  Object.entries(STYLE_STYLESHEETS).map(([style, sheet]) => [style, href(sheet.filename)]),
);
