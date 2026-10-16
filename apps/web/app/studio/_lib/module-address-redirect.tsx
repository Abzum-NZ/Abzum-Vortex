import { redirect } from "next/navigation";
import { loadStudioModuleOwner } from "../../_lib/studio-module-owner";
import { StudioUnavailable } from "../_components/studio-unavailable";
import type { StudioModuleTool } from "./studio-module-tools";

export type StudioModuleAddressParams = Promise<{ organizationId: string; moduleRootId: string }>;

/**
 * A module's editors open only in the Data tab of the application that uses it. A module address
 * (bookmarks, the Studio home) leads there with the module and editor selected; a module no
 * application uses leads to the organisation's Studio home, which says why.
 */
export async function StudioModuleAddress({ params, tool }: Readonly<{ params: StudioModuleAddressParams; tool: StudioModuleTool }>) {
  const { organizationId, moduleRootId } = await params;
  const owner = await loadStudioModuleOwner(organizationId, moduleRootId);
  if (owner.kind === "owned")
    redirect(`/studio/${encodeURIComponent(owner.organizationId)}/${encodeURIComponent(owner.applicationRootId)}?${
      new URLSearchParams({ tab: "data", module: moduleRootId, tool })}`);
  if (owner.kind === "unowned")
    redirect(`/studio/${encodeURIComponent(owner.organizationId)}?notice=module-without-application`);
  return <StudioUnavailable subject="Module" result={owner} />;
}
