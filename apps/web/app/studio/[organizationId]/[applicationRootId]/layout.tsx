import type { ReactNode } from "react";
import { loadStudioApplicationHistoryAccess } from "../../../_lib/studio-application-history";

export default async function StudioApplicationLayout({ children, params }: {
  children: ReactNode;
  params: Promise<{ organizationId: string; applicationRootId: string }>;
}) {
  const { organizationId, applicationRootId } = await params;
  const result = await loadStudioApplicationHistoryAccess(organizationId, applicationRootId);
  return <>
    {result.kind === "available" && <nav aria-label="Application release navigation"
      className="mx-auto flex max-w-7xl justify-end px-6 pt-4">
      <a className="rounded border px-3 py-2 underline"
        href={`/studio/${encodeURIComponent(result.snapshot.organizationId)}/${encodeURIComponent(result.snapshot.rootId)}/history`}
        target="_blank" rel="noopener noreferrer" data-semantic-command="application.release_history.open">
        History <span className="text-sm">(opens in a new tab)</span>
      </a>
      <a className="rounded border px-3 py-2 underline"
        href={`/studio/${encodeURIComponent(result.snapshot.organizationId)}/${encodeURIComponent(result.snapshot.rootId)}/page-adoption`}
        target="_blank" rel="noopener noreferrer" data-semantic-command="application.standard_page_adoption.open">
        Page adoption <span className="text-sm">(opens in a new tab)</span>
      </a>
    </nav>}
    {children}
  </>;
}
