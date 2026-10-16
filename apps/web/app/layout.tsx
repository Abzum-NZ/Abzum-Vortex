import type { Metadata } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { SHADCN_FONT_VARIABLE_CLASSES } from "./catalogue-fonts";
import {
  APPEARANCE_COOKIE,
  AppearanceProvider,
  createAppearanceRootProps,
  createThemeRootProps,
  parseThemeMode,
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
 * The registered platform theme, as the theme renderer emits it. The bootstrap landing, sign-in, organisation chooser and
 * error pages read them before any organisation is known, so they reveal no organisation theme.
 */
const PLATFORM_THEME = createThemeRootProps(undefined, DEFAULT_PLATFORM_THEME_RELEASE.tokens);

/**
 * The platform root's style attributes. No organisation is known here, so they resolve to the
 * platform defaults; a runtime page or preview canvas carries the attributes its own resolved
 * theme selected inside this document.
 */
const PLATFORM_VORTEX_STYLE = createVortexStyleRootProps(resolveVortexStyleSelection());

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // The viewer's appearance choice (one cookie, all applications), so the first server render is right.
  const appearance = parseThemeMode((await cookies()).get(APPEARANCE_COOKIE)?.value);
  const appearanceRoot = createAppearanceRootProps(appearance);
  return (
    <html
      lang="en"
      className={SHADCN_FONT_VARIABLE_CLASSES.join(" ")}
      {...PLATFORM_VORTEX_STYLE}
      data-vortex-theme={PLATFORM_THEME["data-vortex-theme"]}
      data-vortex-theme-mode={appearanceRoot["data-vortex-theme-mode"]}
      style={{ ...PLATFORM_THEME.style, ...PLATFORM_VORTEX_STYLE.style, ...appearanceRoot.style }}
    >
      <body>
        <AppearanceProvider initial={appearance}>{children}</AppearanceProvider>
      </body>
    </html>
  );
}
