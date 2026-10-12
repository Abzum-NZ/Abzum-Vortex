import type { Metadata } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import {
  createThemeRootProps,
  createVortexStyleRootProps,
  resolveVortexStyleSelection,
} from "@vortex/ui";
import "@vortex/ui/styles/globals.css";

const inter = localFont({
  src: "./fonts/inter-latin-wght-normal.woff2",
  display: "swap",
  weight: "100 900",
  variable: "--vortex-font-inter",
});

export const metadata: Metadata = {
  title: "Vortex",
  description: "The Vortex application platform.",
};

/**
 * The registered platform theme's variables, as the theme renderer emits them, following the
 * person's colour-scheme preference. The bootstrap landing, sign-in, organisation chooser and
 * error pages read them before any organisation is known, so they reveal no organisation theme.
 */
const PLATFORM_THEME_STYLE = createThemeRootProps(undefined, "system").style;

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
      className={inter.variable}
      style={PLATFORM_THEME_STYLE}
      {...PLATFORM_VORTEX_STYLE}
    >
      <body>{children}</body>
    </html>
  );
}
