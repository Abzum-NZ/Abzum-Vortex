import { notFound, redirect } from "next/navigation";
import { UnavailableState } from "../_components/unavailable-state";
import { continueStudioSession } from "./_lib/studio-session";
import { StudioUnavailable } from "./_components/studio-unavailable";
import { loadOrganizationLauncher } from "../_lib/organization-context";
import {
  loadFirstApplicationsPageHref,
  loadOrganizationAppStoreAddress,
} from "../_lib/applications-page";

export const dynamic = "force-dynamic";

/**
 * Studio's landing: the one Applications page of the first organisation this person may build in.
 * Studio has no list of its own; the editor keeps its own workspace.
 */
export default async function StudioLandingPage() {
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
  const href = await loadFirstApplicationsPageHref(
    resolved.session,
    launcher.entries.map((entry) => ({
      organizationId: entry.organizationId,
      tenantShortName: entry.tenantShortName,
      organizationShortName: entry.organizationShortName,
    })),
  );
  if (href !== undefined) redirect(href);
  // No organisation names an App Store the person can open: the first one's answer says why (the
  // reads above are the request's, so this reads nothing again).
  const first = launcher.entries[0];
  if (first === undefined) notFound();
  const address = await loadOrganizationAppStoreAddress(resolved.session, first.organizationId);
  if (address.kind === "available") notFound();
  return <StudioUnavailable subject="Studio" result={address} />;
}
