import { notFound, redirect } from "next/navigation";
import { UnavailableState } from "../../_components/unavailable-state";
import { continueStudioSession } from "../_lib/studio-session";
import { StudioUnavailable } from "../_components/studio-unavailable";
import { loadOrganizationLauncher } from "../../_lib/organization-context";
import {
  applicationsPageHref,
  loadOrganizationAppStoreAddress,
} from "../../_lib/applications-page";

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
  // The organisation's App Store names the Applications page; an address that is not set says who
  // sets it, and a read that failed (logged once by the read) offers Try again.
  const address = await loadOrganizationAppStoreAddress(resolved.session, entry.organizationId);
  if (address.kind !== "available") return <StudioUnavailable subject="Studio" result={address} />;
  redirect(applicationsPageHref(entry, address.key));
}
