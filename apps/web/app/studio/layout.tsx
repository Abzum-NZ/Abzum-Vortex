import type { ReactNode } from "react";
import { TooltipProvider } from "@vortex/ui/components/tooltip";
import { documentStylesheetHref } from "../_lib/document-styles";

/**
 * Studio's stylesheet and tooltips. The theme root is the organisation's own layout
 * (`[organizationId]/layout.tsx`): one root carries the theme, so an organisation switch inside
 * Studio re-draws it.
 */
export default function StudioLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <>
      <link rel="stylesheet" href={documentStylesheetHref("studio")} precedence="platform" />
      <TooltipProvider>{children}</TooltipProvider>
    </>
  );
}
