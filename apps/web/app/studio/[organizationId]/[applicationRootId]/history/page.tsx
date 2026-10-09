import { listStudioApplicationReleaseHistory } from "../../../../_lib/studio-application-history";
import { ApplicationReleaseHistory } from "../../../_components/application-release-history";

export const dynamic = "force-dynamic";

export default async function StudioApplicationHistoryPage({ params }: {
  params: Promise<{ organizationId: string; applicationRootId: string }>;
}) {
  const { organizationId, applicationRootId } = await params;
  const result = await listStudioApplicationReleaseHistory(organizationId,
    { kind: "reload", rootId: applicationRootId });
  if (result.kind !== "available") return <main className="mx-auto max-w-3xl space-y-4 p-6">
    <h1 className="text-2xl font-semibold">Application release history unavailable</h1>
    <p role="status">{result.kind === "temporarily_unavailable"
      ? "Release history is temporarily unavailable. Try loading this page again."
      : result.kind === "conflict"
        ? "The saved application changed while history was loading. Reload to read its current history."
        : "Release history is unavailable. Sign in with an account permitted to manage this draft and try again."}</p>
    <a className="underline" href={`/studio/${encodeURIComponent(organizationId)}/${encodeURIComponent(applicationRootId)}/history`}>
      Reload history
    </a>
  </main>;
  const snapshot = result.page.snapshot;
  return <ApplicationReleaseHistory
    key={`${snapshot.organizationId}:${snapshot.rootId}:${snapshot.draftRevision}:${snapshot.sourceFingerprint}:${snapshot.anchorReleaseRevision}`}
    initialPage={result.page} />;
}
