import { notFound, redirect } from "next/navigation";
import { UnavailableState } from "../../_components/unavailable-state";
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
    return <StudioUnavailable subject="Studio" result={resolved} />;
  const launcher = await loadOrganizationLauncher(resolved.session);
  if (launcher.kind !== "available") {
    // The launcher read logged this answer once, where it arose.
    return (
      <UnavailableState
        title="Studio could not load your organisations"
        sentence="Your sign-in is active, but your organisations could not be read just now. Try again."
        way={{ kind: "retry" }}
      />
    );
  }
  const entry = launcher.entries.find((candidate) => candidate.organizationId === organizationId);
  if (entry === undefined) notFound();
  const href = await loadApplicationsPageHref(resolved.session, {
    organizationId: entry.organizationId,
    tenantShortName: entry.tenantShortName,
    organizationShortName: entry.organizationShortName,
  });
  // No App Store address (or one that could not be read; the read logged that): never a missing page.
  if (href === undefined)
    return (
      <UnavailableState
        title="Applications could not be opened"
        sentence="This organisation has no App Store address set, or it could not be read just now. Try again, or ask an organisation administrator to set it in Organisation administration."
        way={{ kind: "retry" }}
      />
    );
  redirect(href);
}
