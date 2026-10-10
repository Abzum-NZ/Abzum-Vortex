import { loadStudioApplicationDraft } from "../../../_lib/studio-application-draft";
import { ApplicationDraftWorkspace } from "../../_components/application-draft-workspace";

export const dynamic = "force-dynamic";

export default async function StudioApplicationPage({ params }: {
  params: Promise<{ organizationId: string; applicationRootId: string }>;
}) {
  const { organizationId, applicationRootId } = await params;
  const result = await loadStudioApplicationDraft(organizationId, applicationRootId);
  if (result.kind !== "available")
    return <main className="mx-auto max-w-3xl p-6"><h1>Studio unavailable</h1>
      <p role="status">This draft is unavailable. Sign in with an account permitted to manage drafts and try again.</p></main>;
  return <ApplicationDraftWorkspace key={`${result.organizationId}:${result.draft.rootId}`}
    mode="existing" organizationId={result.organizationId} draft={result.draft} searchMetadata={result.searchMetadata} />;
}
