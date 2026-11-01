import { notFound, redirect } from "next/navigation";
import { continueStudioSession } from "../_lib/studio-session";
import { StudioUnavailable } from "../_components/studio-unavailable";
import { loadOrganizationLauncher } from "../../_lib/organization-context";
import { loadApplicationsPageHref } from "../../_lib/applications-page";

export const dynamic = "force-dynamic";

/**
 * One organisation's Studio address lands on the Applications page: the App Store's list in the
 * shared application frame is the one place applications are listed, opened, edited and upgraded.
 */
export default async function StudioOrganizationPage({
  params,
}: Readonly<{ params: Promise<{ organizationId: string }> }>) {
  const { organizationId } = await params;
  const resolved = await continueStudioSession();
  if (resolved.kind === "temporarily_unavailable")
    return <StudioUnavailable subject="Studio" result={resolved} reloadHref="/studio" />;
  const launcher = await loadOrganizationLauncher(resolved.session);
  if (launcher.kind !== "available") {
    console.error(`[studio] organization landing could not list organisations: ${launcher.kind}`);
    return (
      <main className="mx-auto max-w-4xl space-y-4 p-6">
        <h1 className="text-2xl font-semibold">Studio</h1>
        <p role="status">Studio could not load your organisations. Try again shortly.</p>
      </main>
    );
  }
  const entry = launcher.entries.find((candidate) => candidate.organizationId === organizationId);
  if (entry === undefined) notFound();
  const href = await loadApplicationsPageHref(resolved.session, {
    organizationId: entry.organizationId,
    tenantShortName: entry.tenantShortName,
    organizationShortName: entry.organizationShortName,
  });
  if (href === undefined) notFound();
  redirect(href);
}
