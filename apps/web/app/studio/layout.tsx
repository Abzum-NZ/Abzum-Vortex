import type { ReactNode } from "react";
import { VortexStyleRoot } from "@vortex/ui/theme";
import { Toaster } from "@vortex/ui/components/sonner";
import { TooltipProvider } from "@vortex/ui/components/tooltip";
import { STUDIO_DOCUMENT_THEME } from "../_lib/document-theme";
import { documentStylesheetHref } from "../_lib/document-styles";

export default function StudioLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <VortexStyleRoot documentTheme {...STUDIO_DOCUMENT_THEME}>
      <link rel="stylesheet" href={documentStylesheetHref("studio")} precedence="platform" />
      <TooltipProvider>
        {children}
        <Toaster position="bottom-right" visibleToasts={3} closeButton />
      </TooltipProvider>
    </VortexStyleRoot>
  );
}
