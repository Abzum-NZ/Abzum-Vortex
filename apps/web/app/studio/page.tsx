import { notFound, redirect } from "next/navigation";
import { continueStudioSession } from "./_lib/studio-session";
import { StudioUnavailable } from "./_components/studio-unavailable";
import { loadOrganizationLauncher } from "../_lib/organization-context";
import { loadFirstApplicationsPageHref } from "../_lib/applications-page";

export const dynamic = "force-dynamic";

/**
 * Studio's landing: the one Applications page of the first organisation this person may build in.
 * Studio has no list of its own; the editor keeps its own workspace.
 */
export default async function StudioLandingPage() {
  const resolved = await continueStudioSession();
  if (resolved.kind === "temporarily_unavailable")
    return <StudioUnavailable subject="Studio" result={resolved} reloadHref="/studio" />;
  const launcher = await loadOrganizationLauncher(resolved.session);
  if (launcher.kind !== "available") {
    console.error(`[studio] landing could not list organisations: ${launcher.kind}`);
    return (
      <main className="mx-auto max-w-4xl space-y-4 p-6">
        <h1 className="text-2xl font-semibold">Studio</h1>
        <p role="status">Studio could not load your organisations. Try again shortly.</p>
      </main>
    );
  }
  const href = await loadFirstApplicationsPageHref(
    resolved.session,
    launcher.entries.map((entry) => ({
      organizationId: entry.organizationId,
      tenantShortName: entry.tenantShortName,
      organizationShortName: entry.organizationShortName,
    })),
  );
  if (href === undefined) notFound();
  redirect(href);
}
