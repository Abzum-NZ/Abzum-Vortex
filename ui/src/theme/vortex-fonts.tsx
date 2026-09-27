import type { ShadcnFont } from "@vortex/contracts";

import { resolveThemeFonts, type ThemeTokens } from "./theme-variables";

/**
 * Where the self-hosted catalogue fonts are served from. `apps/web` publishes `public/` at the root
 * of the Vortex origin, and `tooling/emit-font-assets.mjs` writes each font there, so no font is
 * ever requested from another origin.
 */
export const VORTEX_FONT_BASE_PATH = "/fonts";

/** The address of one catalogue font's stylesheet. */
export function vortexFontStylesheetHref(font: ShadcnFont): string {
  return `${VORTEX_FONT_BASE_PATH}/${font.stylesheet}`;
}

/** The address of one catalogue font's Latin face, which a page preloads. */
export function vortexFontPreloadHref(font: ShadcnFont): string {
  return `${VORTEX_FONT_BASE_PATH}/${font.preload}`;
}

/**
 * Links the stylesheets of exactly the catalogue fonts a resolved theme paints with, its body and
 * heading fonts. By default it also preloads each one's Latin face for the first paint. The root
 * layout can declare the platform face without preloading it on a differently themed application.
 *
 * The links are rendered on the server with hrefs from the fixed catalogue, never from the request.
 * React hoists them into the document head and de-duplicates them by href, so several application
 * roots, or a placement that overrides the typography, add only the fonts no other root has linked.
 * A font stylesheet only declares its faces: a browser downloads a face only for text painted in
 * that family and for the subsets that text uses, so a linked font that nothing paints costs one
 * small stylesheet and no font file.
 */
export function VortexFontStylesheets({
  tokens,
  preload = true,
}: Readonly<{ tokens?: ThemeTokens | undefined; preload?: boolean | undefined }>) {
  return resolveThemeFonts(tokens).map((font) => (
    <FontLinks key={font.id} font={font} preload={preload} />
  ));
}

function FontLinks({ font, preload }: Readonly<{ font: ShadcnFont; preload: boolean }>) {
  return (
    <>
      {preload ? (
        <link
          rel="preload"
          href={vortexFontPreloadHref(font)}
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      ) : null}
      <link
        rel="stylesheet"
        href={vortexFontStylesheetHref(font)}
        data-vortex-font={font.id}
        precedence="vortex-font"
      />
    </>
  );
}
