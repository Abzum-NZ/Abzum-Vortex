import { revisionSchema } from "@vortex/contracts";
import { loadStudioApplicationFirstInstall } from "../../../../../../_lib/studio-application-installation";
import {
  studioApplicationFirstInstallSelectorSchema,
} from "../../../../../../_lib/studio-application-installation-contracts";
import { ApplicationFirstInstallation } from "../../../../../../studio/_components/application-first-installation";

export const dynamic = "force-dynamic";

const unavailableRoute = (organizationId: string, applicationRootId: string) => (
  <main className="mx-auto max-w-3xl space-y-4 p-6">
    <h1 className="text-2xl font-semibold">First installation unavailable</h1>
    <p role="status">The requested release could not be safely selected. Return to release history and inspect a published version.</p>
    <a className="underline" href={`/studio/${encodeURIComponent(organizationId)}/${encodeURIComponent(applicationRootId)}/history`}>
      Return to release history
    </a>
  </main>
);

export default async function StudioApplicationFirstInstallationPage({ params }: {
  params: Promise<{ organizationId: string; applicationRootId: string; releaseRevision: string }>;
}) {
  const { organizationId, applicationRootId, releaseRevision: revisionText } = await params;
  if (!/^[1-9]\d*$/.test(revisionText)) return unavailableRoute(organizationId, applicationRootId);
  const revision = revisionSchema.safeParse(Number(revisionText));
  if (!revision.success || String(revision.data) !== revisionText)
    return unavailableRoute(organizationId, applicationRootId);
  const selector = studioApplicationFirstInstallSelectorSchema.safeParse({
    organizationId,
    rootId: applicationRootId,
    releaseRevision: revision.data,
  });
  if (!selector.success) return unavailableRoute(organizationId, applicationRootId);
  const initialResult = await loadStudioApplicationFirstInstall(organizationId, selector.data);
  return <ApplicationFirstInstallation
    key={`${selector.data.organizationId}:${selector.data.rootId}:${selector.data.releaseRevision}:${JSON.stringify(initialResult)}`}
    selector={selector.data}
    initialResult={initialResult}
  />;
}
