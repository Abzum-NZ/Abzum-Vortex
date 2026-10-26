import type { Metadata } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { SHADCN_FONT_VARIABLE_CLASSES } from "./catalogue-fonts";
import {
  APPEARANCE_COOKIE,
  createAppearanceRootProps,
  parseThemeMode,
} from "@vortex/ui/theme/appearance";
import { AppearanceProvider } from "@vortex/ui/appearance";
import { Toaster } from "@vortex/ui/components/sonner";
import { loadDocumentTheme } from "./_lib/document-theme";
import { documentStylesheetHref } from "./_lib/document-styles";
import "@vortex/ui/styles/globals.css";
import { HistoryRefresh } from "./_components/history-refresh";

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
        <link
          rel="stylesheet"
          href={documentStylesheetHref(documentTheme.stylesheet)}
          precedence="platform"
        />
        {/* The one delivery of the shared component styles: a cached asset, never inlined. */}
        <link rel="stylesheet" href={documentStylesheetHref("components")} precedence="default" />
      </head>
      <body>
        <AppearanceProvider initial={appearance}>
          <HistoryRefresh />
          {children}
          {/* One notifications region for every page, so a toast survives opening another
              application. The document root carries the on-screen application's theme. */}
          <Toaster position="bottom-right" visibleToasts={3} closeButton />
        </AppearanceProvider>
      </body>
    </html>
  );
}
