import { loadStudioCreateAccess } from "../../../_lib/studio-application-draft";
import { ApplicationDraftWorkspace } from "../../_components/application-draft-workspace";

export const dynamic = "force-dynamic";

export default async function NewStudioApplicationPage({ params }: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  const result = await loadStudioCreateAccess(organizationId);
  if (result.kind !== "available")
    return <main className="mx-auto max-w-3xl p-6"><h1>Studio unavailable</h1>
      <p role="status">This workspace is unavailable. Sign in with an account permitted to manage drafts and try again.</p></main>;
  return <ApplicationDraftWorkspace mode="new" organizationId={result.organizationId} />;
}
