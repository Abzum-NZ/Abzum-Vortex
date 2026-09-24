import Link from "next/link";
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
import { AuthShell } from "../../../auth/_components/auth-shell";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";
import { resolveApplicationAddress } from "../../../_lib/application-address";

export const dynamic = "force-dynamic";

type ApplicationAddressPageProps = Readonly<{
  params: Promise<{
    tenantShortName: string;
    organizationShortName: string;
    applicationAddress?: string[];
  }>;
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

export default async function ApplicationAddressPage({ params }: ApplicationAddressPageProps) {
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

  if (addressSegments.length > 2)
    return (
      <AuthShell
        eyebrow="Application access"
        title="Application unavailable"
        description="This application address cannot be opened from your current sign-in."
      >
        <Link href="/signed-in">Choose an organisation</Link>
      </AuthShell>
    );

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
    return (
      <AuthShell
        eyebrow="Application access"
        title="Application unavailable"
        description="This application address cannot be opened from your current sign-in."
      >
        <Link href="/signed-in">Choose an organisation</Link>
      </AuthShell>
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
              projectedData={{ status: "ready", values: launcherValues }}
              displayEvents={{ row_action: openApplication }}
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

  return (
    <AuthShell
      eyebrow={resolved.read.organizationShortName}
      title={resolved.application.name}
      description="This application page is available to your current organisation account."
    >
      <Link
        href={addressPath(
          tenantShortName,
          organizationShortName,
          resolved.application.key,
          resolved.application.homePageKey,
        )}
      >
        Open application start page
      </Link>
      <Link href={launcherPath(tenantShortName, organizationShortName)}>Application launcher</Link>
    </AuthShell>
  );
}
