import type { ReactNode } from "react";
import { VortexStyleRoot } from "@vortex/ui/theme";
import { TooltipProvider } from "@vortex/ui/components/tooltip";
import { loadStudioDocumentTheme } from "../_lib/document-theme";
import { documentStylesheetHref } from "../_lib/document-styles";

/** Studio is drawn in its platform theme, with the theme of the organisation its address names. */
export default async function StudioLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <VortexStyleRoot documentTheme className="h-full" {...await loadStudioDocumentTheme()}>
      <link rel="stylesheet" href={documentStylesheetHref("studio")} precedence="platform" />
      <TooltipProvider>{children}</TooltipProvider>
    </VortexStyleRoot>
  );
}
