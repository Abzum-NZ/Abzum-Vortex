import type { ReactNode } from "react";
import { VortexStyleRoot } from "@vortex/ui/theme";
import { loadStudioDocumentTheme } from "../../_lib/document-theme";

/** Studio is drawn in its platform theme with the theme of the organisation the route names. */
export default async function StudioOrganizationLayout({
  children,
  params,
}: Readonly<{ children: ReactNode; params: Promise<{ organizationId: string }> }>) {
  const { organizationId } = await params;
  return (
    <VortexStyleRoot
      documentTheme
      className="h-full"
      {...await loadStudioDocumentTheme(organizationId)}
    >
      {children}
    </VortexStyleRoot>
  );
}
