import { revisionSchema } from "@vortex/contracts";
import { loadStudioApplicationRestore } from "../../../../../../_lib/studio-application-restore";
import { studioApplicationRestoreSelectorSchema } from "../../../../../../_lib/studio-application-restore-contracts";
import { ApplicationReleaseRestore } from "../../../../../../studio/_components/application-release-restore";

export const dynamic = "force-dynamic";

const unavailableRoute = (organizationId: string, applicationRootId: string) => (
  <main className="mx-auto max-w-3xl space-y-4 p-6">
    <h1 className="text-2xl font-semibold">Application restore unavailable</h1>
    <p role="status">The requested release could not be safely selected. Return to release history and inspect a published version.</p>
    <a className="underline" href={`/studio/${encodeURIComponent(organizationId)}/${encodeURIComponent(applicationRootId)}/history`}>
      Return to release history
    </a>
  </main>
);

export default async function StudioApplicationRestorePage({ params }: {
  params: Promise<{ organizationId: string; applicationRootId: string; releaseRevision: string }>;
}) {
  const { organizationId, applicationRootId, releaseRevision: revisionText } = await params;
  if (!/^[1-9]\d*$/.test(revisionText)) return unavailableRoute(organizationId, applicationRootId);
  const revision = revisionSchema.safeParse(Number(revisionText));
  if (!revision.success || String(revision.data) !== revisionText)
    return unavailableRoute(organizationId, applicationRootId);

  const parsedSelector = studioApplicationRestoreSelectorSchema.safeParse({
    organizationId,
    rootId: applicationRootId,
    releaseRevision: revision.data,
  });
  if (!parsedSelector.success) return unavailableRoute(organizationId, applicationRootId);

  const selector = parsedSelector.data;
  const initialResult = await loadStudioApplicationRestore(organizationId, selector);
  return <ApplicationReleaseRestore
    key={`${selector.organizationId}:${selector.rootId}:${selector.releaseRevision}:${JSON.stringify(initialResult)}`}
    selector={selector}
    initialResult={initialResult}
  />;
}
