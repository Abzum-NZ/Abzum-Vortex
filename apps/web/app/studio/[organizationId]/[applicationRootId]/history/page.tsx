import { listStudioApplicationReleaseHistory } from "../../../../_lib/studio-application-history";
import { StudioUnavailable } from "../../../_components/studio-unavailable";
import { ApplicationReleaseHistory } from "../../../_components/application-release-history";

export const dynamic = "force-dynamic";

export default async function StudioApplicationHistoryPage({ params }: {
  params: Promise<{ organizationId: string; applicationRootId: string }>;
}) {
  const { organizationId, applicationRootId } = await params;
  const result = await listStudioApplicationReleaseHistory(organizationId,
    { kind: "reload", rootId: applicationRootId });
  if (result.kind !== "available")
    return <StudioUnavailable subject="Application release history" result={result}
      reloadHref={`/studio/${encodeURIComponent(organizationId)}/${encodeURIComponent(applicationRootId)}/history`} />;
  const snapshot = result.page.snapshot;
  return <ApplicationReleaseHistory
    key={`${snapshot.organizationId}:${snapshot.rootId}:${snapshot.draftRevision}:${snapshot.sourceFingerprint}:${snapshot.anchorReleaseRevision}`}
    initialPage={result.page} />;
}
