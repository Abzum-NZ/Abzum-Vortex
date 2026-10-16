import type { Metadata } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { SHADCN_FONT_VARIABLE_CLASSES } from "./catalogue-fonts";
import {
  APPEARANCE_COOKIE,
  AppearanceProvider,
  createAppearanceRootProps,
  parseThemeMode,
} from "@vortex/ui";
import { loadDocumentTheme, PLATFORM_ROOT_CSS } from "./_lib/document-theme";
import "@vortex/ui/styles/globals.css";

export const metadata: Metadata = {
  title: "Vortex",
  description: "The Vortex application platform.",
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // The viewer's appearance choice (one cookie, all applications), so the first server render is right.
  const appearance = parseThemeMode((await cookies()).get(APPEARANCE_COOKIE)?.value);
  const appearanceRoot = createAppearanceRootProps(appearance);
  // The addressed application's theme, or the platform default, so the first paint is already right.
  const documentTheme = await loadDocumentTheme();
  return (
    <html
      lang="en"
      className={SHADCN_FONT_VARIABLE_CLASSES.join(" ")}
      {...documentTheme.attributes}
      data-vortex-theme=""
      data-vortex-theme-mode={appearanceRoot["data-vortex-theme-mode"]}
      style={{ ...documentTheme.style, ...appearanceRoot.style }}
    >
      <head>
        <style>{PLATFORM_ROOT_CSS}</style>
      </head>
      <body>
        <AppearanceProvider initial={appearance}>{children}</AppearanceProvider>
      </body>
    </html>
  );
}
