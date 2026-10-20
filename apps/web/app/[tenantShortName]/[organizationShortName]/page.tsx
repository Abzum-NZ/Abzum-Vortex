import "server-only";

import { redirect } from "next/navigation";
import {
  parsePermittedApplicationsLauncherProjection,
  permittedApplicationsToListValues,
  type ApplicationAccount,
  type DisplaySemanticEvent,
} from "@vortex/ui";
import {
  DEFAULT_PLATFORM_THEME_RELEASE,
  FIELD_INPUT_CONTROL_RELEASES,
  organizationLauncherPage,
  organizationLauncherPlacementId,
  organizationLauncherShell,
} from "@vortex/platform/server";
import { OrganizationLauncherPage } from "./_components/organization-launcher-page";
import {
  suspendedOrganizationAccount,
  TemporarilyUnavailableAddress,
  unavailableAddress,
} from "./_components/address-states";
import { openPermittedApplication } from "./_components/open-application";
import { continueSessionOrEnd } from "../../auth/_lib/session-redirect";
import { resolveIdentitySessionWithEmail } from "../../auth/_lib/session-server";
import { loadOrganizationLauncher } from "../../_lib/organization-context";
import {
  applicationPageAddressPath as addressPath,
  organizationAddressPath as launcherPath,
} from "../../_lib/address-paths";
import { resolveApplicationAddress } from "../../_lib/application-address";
import { loadStudioCreateAccess } from "../../_lib/studio-application-draft";
import { platformBlockReleasesFor } from "../../_lib/platform-block-releases";

export const dynamic = "force-dynamic";

/** The launcher row that opens Studio rather than an installed application. */
const STUDIO_TILE_ID = "studio";

type OrganizationPageProps = Readonly<{
  params: Promise<{ tenantShortName: string; organizationShortName: string }>;
}>;

/**
 * The organisation address: it opens the organisation's default application, or shows the
 * launcher of every application the signed-in person may open.
 */
export default async function OrganizationPage({ params }: OrganizationPageProps) {
  const { tenantShortName, organizationShortName } = await params;
  const { resolution, email } = await resolveIdentitySessionWithEmail();
  const identity = await continueSessionOrEnd(resolution);
  const retryHref = launcherPath(tenantShortName, organizationShortName);

  async function openApplication(event: DisplaySemanticEvent): Promise<void> {
    "use server";
    await openPermittedApplication(tenantShortName, organizationShortName, event);
  }

  if (identity.kind === "temporarily_unavailable")
    return <TemporarilyUnavailableAddress retryHref={retryHref} />;
  if (email === undefined) throw new Error("Active identity session resolved without an email");

  const resolved = await resolveApplicationAddress(
    identity.session,
    tenantShortName,
    organizationShortName,
  );
  if (resolved.kind === "temporarily_unavailable")
    return <TemporarilyUnavailableAddress retryHref={retryHref} />;
  if (resolved.kind === "suspended_super_administrator_account")
    return suspendedOrganizationAccount;
  if (resolved.kind !== "organization_launcher") return unavailableAddress;

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

  const launcher = await loadOrganizationLauncher(identity.session);
  if (launcher.kind !== "available")
    throw new Error(`Organisation launcher unavailable for the account menu: ${launcher.kind}`);
  const displayName = launcher.entries.find(
    (entry) =>
      entry.tenantShortName === tenantShortName &&
      entry.organizationShortName === organizationShortName,
  )?.accountDisplayName;
  const account: ApplicationAccount =
    displayName === undefined ? { email } : { email, displayName };

  const projection = parsePermittedApplicationsLauncherProjection(resolved.read);
  if (projection.kind !== "available")
    throw new Error("Available organisation launcher read produced an unavailable projection");
  const permittedValues = permittedApplicationsToListValues(projection);
  const studioCreateAccess = await loadStudioCreateAccess(resolved.read.organizationId);
  const studio =
    studioCreateAccess.kind === "available" &&
    studioCreateAccess.organizationId === resolved.read.organizationId
      ? { href: "/studio", tileId: STUDIO_TILE_ID }
      : undefined;
  const launcherValues =
    studio === undefined
      ? permittedValues
      : {
          ...permittedValues,
          rows: [
            ...permittedValues.rows,
            {
              recordId: studio.tileId,
              cells: {
                name: { kind: "text" as const, text: "Studio" },
                icon: { kind: "text" as const, text: "layout-dashboard" },
                description: { kind: "text" as const, text: "Build applications and modules" },
              },
            },
          ],
        };
  const page = organizationLauncherPage;

  return (
    <OrganizationLauncherPage
      page={page}
      shell={organizationLauncherShell}
      placementId={organizationLauncherPlacementId}
      values={launcherValues}
      organizationName={resolved.read.organizationShortName}
      account={account}
      openApplication={openApplication}
      launcherHref={retryHref}
      platformBlockReleases={platformBlockReleasesFor(page, organizationLauncherShell)}
      fieldInputControlReleases={FIELD_INPUT_CONTROL_RELEASES}
      platformThemeTokens={DEFAULT_PLATFORM_THEME_RELEASE.tokens}
      {...(studio === undefined ? {} : { studio })}
    />
  );
}
