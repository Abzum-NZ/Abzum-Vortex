import type { ReactNode } from "react";
import { headers } from "next/headers";
import { VortexStyleRoot } from "@vortex/ui/theme";
import { loadStudioDocumentTheme, STUDIO_DOCUMENT_THEME } from "../../_lib/document-theme";
import { requestAddressHeader } from "../../_lib/request-address";
import { StudioUnavailable } from "../_components/studio-unavailable";

/**
 * Studio is drawn in its platform theme with the theme of the organisation the route names. When
 * that theme cannot be read now, Studio keeps its own theme and says it is temporarily unavailable,
 * with a reload of the same address.
 */
export default async function StudioOrganizationLayout({
  children,
  params,
}: Readonly<{ children: ReactNode; params: Promise<{ organizationId: string }> }>) {
  const { organizationId } = await params;
  const theme = await loadStudioDocumentTheme(organizationId);
  if (theme === "temporarily_unavailable")
    return (
      <VortexStyleRoot documentTheme className="h-full" {...STUDIO_DOCUMENT_THEME}>
        <StudioUnavailable
          subject="Studio"
          result={{ kind: "temporarily_unavailable" }}
          reloadHref={
            (await headers()).get(requestAddressHeader) ??
            `/studio/${encodeURIComponent(organizationId)}`
          }
        />
      </VortexStyleRoot>
    );
  return (
    <VortexStyleRoot documentTheme className="h-full" {...theme}>
      {children}
    </VortexStyleRoot>
  );
}
