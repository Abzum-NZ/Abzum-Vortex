import type { ReactNode } from "react";
import { ALL_UI_STYLES_CSS, VortexStyleRoot } from "@vortex/ui";
import { Toaster } from "@vortex/ui/components/sonner";
import { TooltipProvider } from "@vortex/ui/components/tooltip";
import { STUDIO_DOCUMENT_THEME } from "../_lib/document-theme";

export default function StudioLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <VortexStyleRoot documentTheme {...STUDIO_DOCUMENT_THEME}>
      <style href="vortex-ui-styles" precedence="default">
        {ALL_UI_STYLES_CSS}
      </style>
      <TooltipProvider>
        {children}
        <Toaster position="bottom-right" visibleToasts={3} closeButton />
      </TooltipProvider>
    </VortexStyleRoot>
  );
}
