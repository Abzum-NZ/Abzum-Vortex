import type { Metadata } from "next";
import type { ReactNode } from "react";
import { createThemeRootProps } from "@vortex/ui";
import "./globals.css";

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

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" style={PLATFORM_THEME_STYLE}>
      <body>{children}</body>
    </html>
  );
}
