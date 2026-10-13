import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SHADCN_FONT_VARIABLE_CLASSES } from "./catalogue-fonts";
import {
  createThemeRootProps,
  createVortexStyleRootProps,
  resolveVortexStyleSelection,
} from "@vortex/ui";
import { DEFAULT_PLATFORM_THEME_RELEASE } from "@vortex/platform/server";
import "@vortex/ui/styles/globals.css";

export const metadata: Metadata = {
  title: "Vortex",
  description: "The Vortex application platform.",
};

/**
 * The registered platform theme's variables, as the theme renderer emits them, following the
 * person's colour-scheme preference. The bootstrap landing, sign-in, organisation chooser and
 * error pages read them before any organisation is known, so they reveal no organisation theme.
 */
const PLATFORM_THEME_STYLE = createThemeRootProps(
  undefined,
  DEFAULT_PLATFORM_THEME_RELEASE.tokens,
  "system",
).style;

/**
 * The platform root's style attributes. No organisation is known here, so they resolve to the
 * platform defaults; a runtime page or preview canvas carries the attributes its own resolved
 * theme selected inside this document.
 */
const PLATFORM_VORTEX_STYLE = createVortexStyleRootProps(resolveVortexStyleSelection());

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html
      lang="en"
      className={SHADCN_FONT_VARIABLE_CLASSES.join(" ")}
      {...PLATFORM_VORTEX_STYLE}
      style={{ ...PLATFORM_THEME_STYLE, ...PLATFORM_VORTEX_STYLE.style }}
    >
      <body>{children}</body>
    </html>
  );
}
