import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  ALL_UI_STYLES_CSS,
  APPLICATION_LAUNCHER_BLOCK_RELEASE,
  ApplicationLauncher,
  createThemeRootProps,
  parsePermittedApplicationsLauncherProjection,
  permittedApplicationsToListValues,
  type DisplaySemanticEvent,
} from "@vortex/ui";
import { ApplicationExperiencePage } from "./_components/application-experience-page";
import { ApplicationPageView } from "./_components/application-page-view";
import { AuthShell } from "../../../auth/_components/auth-shell";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";
import { resolveApplicationAddress } from "../../../_lib/application-address";
import { loadApplicationPage } from "../../../_lib/application-page";
import { adoptApplicationRelease } from "../../../_lib/application-release-adoption";

export const dynamic = "force-dynamic";

/**
 * The one fixed neutral state for an address that is refused or missing. It never names the
 * application, a reason, or whether anything exists, so the two cases stay indistinguishable.
 */
const unavailableFallback = (
  <AuthShell
    eyebrow="Application access"
    title="Application unavailable"
    description="This application address cannot be opened from your current sign-in."
  >
    <Link href="/signed-in">Choose an organisation</Link>
  </AuthShell>
);

type ApplicationAddressPageProps = Readonly<{
  params: Promise<{
    tenantShortName: string;
    organizationShortName: string;
    applicationAddress?: string[];
  }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

const addressPath = (
  tenantShortName: string,
  organizationShortName: string,
  applicationKey: string,
  pageKey: string,
) =>
  `/${encodeURIComponent(tenantShortName)}/${encodeURIComponent(organizationShortName)}/${encodeURIComponent(applicationKey)}/${encodeURIComponent(pageKey)}`;

const launcherPath = (tenantShortName: string, organizationShortName: string) =>
  `/${encodeURIComponent(tenantShortName)}/${encodeURIComponent(organizationShortName)}`;

export default async function ApplicationAddressPage({
  params,
  searchParams,
}: ApplicationAddressPageProps) {
  const identity = await resolveIdentitySession();
  if (identity.kind === "invalid_session_state" || identity.kind === "expired_or_revoked")
    redirect("/auth/session-ended");
  if (identity.kind === "missing" || identity.kind === "cluster_identity_inactive")
    redirect("/auth/sign-in?status=session-ended");

  const { tenantShortName, organizationShortName, applicationAddress } = await params;
  const addressSegments = applicationAddress ?? [];

  /**
   * Tile activation is the launcher block's declared `row_action` event. The browser supplies only
   * the tile's application identity; this server action re-resolves the signed-in person's current
   * permitted applications at this address and opens the matching one, so a withdrawn or refused
   * application is never opened from stale page data or a crafted identity.
   */
  async function openApplication(event: DisplaySemanticEvent): Promise<void> {
    "use server";
    if (event?.event !== "row_action" || typeof event.recordId !== "string") return;
    const chooser = launcherPath(tenantShortName, organizationShortName);
    const currentIdentity = await resolveIdentitySession();
    if (currentIdentity.kind === "temporarily_unavailable") redirect(chooser);
    if (
      currentIdentity.kind === "invalid_session_state" ||
      currentIdentity.kind === "expired_or_revoked"
    )
      redirect("/auth/session-ended");
    if (currentIdentity.kind !== "active") redirect("/auth/sign-in?status=session-ended");

    const rechecked = await resolveApplicationAddress(
      currentIdentity.session,
      tenantShortName,
      organizationShortName,
    );
    if (rechecked.kind !== "organization_launcher") redirect(chooser);
    const application = rechecked.read.applications.find(
      (candidate) => candidate.applicationRootId === event.recordId,
    );
    if (application === undefined) redirect(chooser);
    redirect(
      addressPath(tenantShortName, organizationShortName, application.key, application.homePageKey),
    );
  }

  /**
   * Deliberately adopts the offered release of the addressed application. The browser supplies the
   * offered target and the installation revision the page loaded; the server re-resolves the
   * signed-in person's address, re-reads the exact target release and the active installation, and
   * refuses on any mismatch, so a stale page can never upgrade the wrong release. On success the
   * address is revalidated so the next request resolves the new release; on any refusal the prior
   * release keeps rendering.
   */
  async function adoptRelease(formData: FormData): Promise<void> {
    "use server";
    const currentIdentity = await resolveIdentitySession();
    if (currentIdentity.kind === "temporarily_unavailable")
      redirect(launcherPath(tenantShortName, organizationShortName));
    if (
      currentIdentity.kind === "invalid_session_state" ||
      currentIdentity.kind === "expired_or_revoked"
    )
      redirect("/auth/session-ended");
    if (currentIdentity.kind !== "active") redirect("/auth/sign-in?status=session-ended");

    const applicationKey = String(formData.get("applicationKey") ?? "");
    const pageKey = String(formData.get("pageKey") ?? "");
    const offeredReleaseRevision = Number(formData.get("targetReleaseRevision"));
    const expectedActiveReleaseRevision = Number(formData.get("expectedActiveReleaseRevision"));

    const rechecked = await resolveApplicationAddress(
      currentIdentity.session,
      tenantShortName,
      organizationShortName,
      applicationKey,
      pageKey,
    );
    if (rechecked.kind !== "application_page")
      redirect(launcherPath(tenantShortName, organizationShortName));
    const back = addressPath(
      tenantShortName,
      organizationShortName,
      rechecked.application.key,
      rechecked.pageKey,
    );

    let refused = false;
    try {
      await adoptApplicationRelease(currentIdentity.session, {
        organizationId: rechecked.read.organizationId,
        applicationRootId: rechecked.application.applicationRootId,
        applicationReleaseRevision: offeredReleaseRevision,
        expectedActiveReleaseRevision,
      });
    } catch {
      refused = true;
    }
    // A refusal, a stale revision or a failed preparation changes nothing; the page keeps showing
    // the prior release. Only a committed switch invalidates the cached page model.
    if (refused) redirect(`${back}?adoption=refused`);
    revalidatePath(back);
    redirect(`${back}?adoption=adopted`);
  }

  if (identity.kind === "temporarily_unavailable")
    return (
      <AuthShell
        eyebrow="Application access"
        title="This address is temporarily unavailable"
        description="Your sign-in is still active. Try loading this address again."
      >
        <Link href={launcherPath(tenantShortName, organizationShortName)}>Try again</Link>
      </AuthShell>
    );

  if (addressSegments.length > 2) return unavailableFallback;

  const resolved = await resolveApplicationAddress(
    identity.session,
    tenantShortName,
    organizationShortName,
    addressSegments[0],
    addressSegments[1],
  );
  if (resolved.kind === "temporarily_unavailable")
    return (
      <AuthShell
        eyebrow="Application access"
        title="This address is temporarily unavailable"
        description="Your sign-in is still active. Try loading this address again."
      >
        <Link href={launcherPath(tenantShortName, organizationShortName)}>Try again</Link>
      </AuthShell>
    );

  if (resolved.kind === "unavailable")
    // A refused page and a missing page of an application the viewer may open both show that
    // application's own not-found page; everything else shows the fixed neutral fallback.
    return resolved.experience === undefined ? (
      unavailableFallback
    ) : (
      <ApplicationExperiencePage
        page={resolved.experience.page}
        shells={resolved.experience.shells}
      />
    );

  if (resolved.kind === "organization_launcher") {
    const defaultApplication = resolved.read.applications.find(
      (application) => application.applicationRootId === resolved.read.defaultApplicationRootId,
    );
    if (defaultApplication)
      redirect(
        addressPath(
          tenantShortName,
          organizationShortName,
          defaultApplication.key,
          defaultApplication.homePageKey,
        ),
      );

    const projection = parsePermittedApplicationsLauncherProjection(resolved.read);
    const launcherValues =
      projection.kind === "available" ? permittedApplicationsToListValues(projection) : undefined;

    return (
      <AuthShell
        eyebrow={resolved.read.tenantShortName}
        title={resolved.read.organizationShortName}
        description="Choose an application you can open."
      >
        {launcherValues === undefined ? (
          <p>No applications are available for this organisation.</p>
        ) : (
          <div {...createThemeRootProps(undefined)}>
            <style href="vortex-ui-styles" precedence="default">
              {ALL_UI_STYLES_CSS}
            </style>
            <ApplicationLauncher
              placementId="organization-application-launcher"
              settings={{ title: { kind: "text", value: "Available applications" } }}
              slots={{}}
              breakpoint="desktop"
              metadata={APPLICATION_LAUNCHER_BLOCK_RELEASE}
              availability="available"
              data={{ status: "ready", values: launcherValues }}
              events={{ row_action: openApplication }}
            />
          </div>
        )}
        <Link href="/signed-in">Choose another organisation</Link>
      </AuthShell>
    );
  }

  if (addressSegments.length === 1)
    redirect(
      addressPath(
        tenantShortName,
        organizationShortName,
        resolved.application.key,
        resolved.pageKey,
      ),
    );

  // The addressed page: the permission-filtered page, the viewer's menu, the theme and the
  // persisted data are all composed on the server from this person's own request.
  const page = await loadApplicationPage(
    identity.session,
    {
      tenantShortName,
      organizationShortName,
      read: resolved.read,
      application: resolved.application,
      pageKey: resolved.pageKey,
    },
    await searchParams,
  );
  if (page.kind === "temporarily_unavailable")
    return (
      <AuthShell
        eyebrow="Application access"
        title="This address is temporarily unavailable"
        description="Your sign-in is still active. Try loading this address again."
      >
        <Link href={launcherPath(tenantShortName, organizationShortName)}>Try again</Link>
      </AuthShell>
    );
  if (page.kind === "unavailable") return unavailableFallback;
  const adoption = page.model.adoption;
  return (
    <>
      {adoption === undefined ? null : (
        <form action={adoptRelease} data-vortex-release-adoption="offered">
          <input type="hidden" name="applicationKey" value={resolved.application.key} />
          <input type="hidden" name="pageKey" value={resolved.pageKey} />
          <input
            type="hidden"
            name="targetReleaseRevision"
            value={adoption.offeredReleaseRevision}
          />
          <input
            type="hidden"
            name="expectedActiveReleaseRevision"
            value={adoption.installedReleaseRevision}
          />
          <button type="submit">
            Adopt release {adoption.offeredReleaseVersion}
          </button>
        </form>
      )}
      <ApplicationPageView model={page.model} />
    </>
  );
}
