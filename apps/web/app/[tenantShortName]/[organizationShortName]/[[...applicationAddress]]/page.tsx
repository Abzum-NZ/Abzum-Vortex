import "server-only";

import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { recordIdSchema } from "@vortex/platform/schema";
import {
  parsePermittedApplicationsLauncherProjection,
  type ApplicationAccount,
  permittedApplicationsToListValues,
  type DisplaySemanticEvent,
} from "@vortex/ui";
import {
  DEFAULT_PLATFORM_THEME_RELEASE,
  FIELD_INPUT_CONTROL_RELEASES,
  PLATFORM_BLOCK_RELEASES,
} from "@vortex/platform/server";
import type { InstalledRuntimeContext } from "@web/platform-server";
import { ApplicationExperiencePage } from "./_components/application-experience-page";
import { OrganizationLauncherPage } from "./_components/organization-launcher-page";
import { ApplicationPageView } from "./_components/application-page-view";
import { loadApplicationSearch } from "../../../_lib/application-search";
import { Alert, AlertDescription } from "@vortex/ui/components/alert";
import { Button } from "@vortex/ui/components/button";
import { AuthShell } from "../../../auth/_components/auth-shell";
import { applicationHomeContinuationFromAddress } from "../../../auth/_lib/application-home-continuation";
import { continueSessionOrEnd } from "../../../auth/_lib/session-redirect";
import { resolveIdentitySession, resolveIdentitySessionWithEmail } from "../../../auth/_lib/session-server";
import { loadOrganizationLauncher, loadPermittedApplicationsAtAddress } from "../../../_lib/organization-context";
import {
  applicationPageAddressPath as addressPath,
  organizationAddressPath as launcherPath,
} from "../../../_lib/address-paths";
import { resolveApplicationAddress } from "../../../_lib/application-address";
import { loadApplicationPage } from "../../../_lib/application-page";
import { loadStudioCreateAccess } from "../../../_lib/studio-application-draft";
import { adoptApplicationRelease } from "../../../_lib/application-release-adoption";
import { mapWebError } from "../../../_lib/web-error-mapper";
import {
  abandonGuidedFormDraftAction,
  advanceGuidedFormStepAction,
  confirmGuidedFormAction,
} from "./guided-form-actions";
import {
  DefinitionError,
  organizationLauncherPage,
  organizationLauncherPlacementId,
  organizationLauncherShell,
  organizationLauncherStudioPage,
  organizationLauncherStudioPlacementId,
} from "@web/platform-server";

export const dynamic = "force-dynamic";

const adoptionCoordinatorCodes = new Set<string>([
  "INVALID_APPLICATION_INSTALLATION_COMMAND",
  "APPLICATION_INSTALLATION_REFUSED",
  "APPLICATION_INSTALLATION_PERMISSION_REFUSED",
  "APPLICATION_INSTALLATION_RECENT_AUTHENTICATION_REQUIRED",
  "APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE",
  "APPLICATION_INSTALLATION_STALE",
  "APPLICATION_INSTALLATION_INCOMPLETE",
  "APPLICATION_INSTALLATION_STORAGE_INCOMPATIBLE",
  "APPLICATION_INSTALLATION_TEMPORARILY_UNAVAILABLE",
  "APPLICATION_INSTALLATION_FAILED",
]);

/** Only a known coordinator exception can select the display-only authentication notice. */
const adoptionCoordinatorCode = (error: unknown): string => {
  try {
    if (!(error instanceof DefinitionError)) return "UNKNOWN";
    const code: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
    return typeof code === "string" && adoptionCoordinatorCodes.has(code) ? code : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
};

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

/** The browser registry only needs metadata for releases present in this rendered composition. */
const platformBlockReleasesFor = (...compositions: readonly unknown[]) => {
  const availableIdentities = new Set(
    PLATFORM_BLOCK_RELEASES.map((release) => `${release.blockId}:${release.releaseVersion}`),
  );
  const referencedIdentities = new Set<string>();
  const visited = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      if (visited.has(value)) return;
      visited.add(value);
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object" || value === null || visited.has(value)) return;
    visited.add(value);
    const candidate = value as Readonly<{ blockId?: unknown; releaseVersion?: unknown }>;
    if (typeof candidate.blockId === "string" && typeof candidate.releaseVersion === "string") {
      const identity = `${candidate.blockId}:${candidate.releaseVersion}`;
      if (availableIdentities.has(identity)) referencedIdentities.add(identity);
    }
    for (const nested of Object.values(value)) visit(nested);
  };
  for (const composition of compositions) visit(composition);
  return PLATFORM_BLOCK_RELEASES.filter((release) =>
    referencedIdentities.has(`${release.blockId}:${release.releaseVersion}`),
  );
};

/** Whether the addressed page's own shell in this installed release shows the application switcher. */
const switcherShownFor = (
  context: InstalledRuntimeContext | undefined,
  pageKey: string,
): boolean => {
  if (context === undefined) return false;
  const content = context.releaseSet.application.content;
  const composition = content.pages.find((candidate) => candidate.key === pageKey)?.composition;
  const shellId = composition !== undefined && "shellId" in composition ? composition.shellId : undefined;
  if (shellId === undefined) return false;
  const shell = content.shells.find(
    (candidate) => String(candidate.shellId).toLowerCase() === String(shellId).toLowerCase(),
  );
  return shell?.presentation.topBar.applicationSwitcher === true;
};

type ApplicationAddressPageProps = Readonly<{
  params: Promise<{
    tenantShortName: string;
    organizationShortName: string;
    applicationAddress?: string[];
  }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

export default async function ApplicationAddressPage({
  params,
  searchParams,
}: ApplicationAddressPageProps) {
  const { tenantShortName, organizationShortName, applicationAddress } = await params;
  const applicationHome = applicationHomeContinuationFromAddress(
    tenantShortName,
    organizationShortName,
    applicationAddress,
  );
  const { resolution, email } = await resolveIdentitySessionWithEmail();
  const identity = await continueSessionOrEnd(resolution, applicationHome);
  const addressSegments = applicationAddress ?? [];

  /**
   * Tile activation is the launcher block's declared `row_action` event. A query-bound tile sends
   * only its application key; the existing organisation launcher may send the application's stable
   * identity. This server action resolves either identity against the signed-in person's current
   * permitted applications before opening it, so a withdrawn or refused application is never
   * opened from stale page data or a crafted value.
   */
  async function openApplication(event: DisplaySemanticEvent): Promise<void> {
    "use server";
    if (event?.event !== "row_action" || typeof event.recordId !== "string") return;
    const chooser = launcherPath(tenantShortName, organizationShortName);
    const currentIdentity = await continueSessionOrEnd(await resolveIdentitySession());
    if (currentIdentity.kind === "temporarily_unavailable") redirect(chooser);

    const rechecked = await resolveApplicationAddress(
      currentIdentity.session,
      tenantShortName,
      organizationShortName,
    );
    if (rechecked.kind !== "organization_launcher") redirect(chooser);
    const application = rechecked.read.applications.find(
      (candidate) =>
        candidate.key === event.recordId || candidate.applicationRootId === event.recordId,
    );
    if (application === undefined) redirect(chooser);
    redirect(
      addressPath(tenantShortName, organizationShortName, application.key, application.homePageKey),
    );
  }

  /**
   * Deliberately adopts the offered release of the addressed application. The browser supplies the
   * offered target and the installation revision the page loaded; the server re-resolves the
   * signed-in person's address, re-reads the offered release and the active installation, and
   * refuses on any mismatch, so a stale page can never upgrade the wrong release. The page model is
   * never cached (the page is dynamic, ADR 9): only a committed switch revalidates this address so
   * the client drops its rendered copy, and on any refusal the prior release keeps rendering.
   */
  async function adoptRelease(formData: FormData): Promise<void> {
    "use server";
    const currentIdentity = await continueSessionOrEnd(await resolveIdentitySession());
    if (currentIdentity.kind === "temporarily_unavailable")
      redirect(launcherPath(tenantShortName, organizationShortName));

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
    let recentAuthenticationRequired = false;
    try {
      await adoptApplicationRelease(currentIdentity.session, {
        organizationId: rechecked.read.organizationId,
        applicationRootId: rechecked.application.applicationRootId,
        applicationReleaseRevision: offeredReleaseRevision,
        expectedActiveReleaseRevision,
      });
    } catch (error) {
      const coordinatorCode = adoptionCoordinatorCode(error);
      const refusal = mapWebError(error, {
        route: "application-address-page",
        operation: "adopt_application_release",
        code: coordinatorCode === "UNKNOWN" ? "APPLICATION_INSTALLATION_REFUSED" : coordinatorCode,
        fallback: {
          recentAuthenticationRequired:
            coordinatorCode === "APPLICATION_INSTALLATION_RECENT_AUTHENTICATION_REQUIRED",
        },
      });
      recentAuthenticationRequired = refusal.recentAuthenticationRequired;
      refused = true;
    }
    // A refusal, a stale revision or a failed preparation changes nothing; the page keeps showing
    // the prior release. Only a committed switch revalidates the address.
    if (refused)
      redirect(
        `${back}?adoption=${recentAuthenticationRequired ? "recent_authentication_required" : "refused"}`,
      );
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
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link href={launcherPath(tenantShortName, organizationShortName)} />}
        >
          Try again
        </Button>
      </AuthShell>
    );

  if (email === undefined) throw new Error("Active identity session resolved without an email");
  const accountWithName = (displayName: string | undefined): ApplicationAccount =>
    displayName === undefined ? { email } : { email, displayName };
  // Pages that do not already read the addressed organisation's account look it up here.
  const loadAccount = async (): Promise<ApplicationAccount> => {
    const launcher = await loadOrganizationLauncher(identity.session);
    if (launcher.kind !== "available")
      throw new Error(`Organisation launcher unavailable for the account menu: ${launcher.kind}`);
    return accountWithName(
      launcher.entries.find(
        (entry) =>
          entry.tenantShortName === tenantShortName &&
          entry.organizationShortName === organizationShortName,
      )?.accountDisplayName,
    );
  };

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
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link href={launcherPath(tenantShortName, organizationShortName)} />}
        >
          Try again
        </Button>
      </AuthShell>
    );

  if (resolved.kind === "suspended_super_administrator_account")
    return (
      <AuthShell
        eyebrow="Organisation access"
        title="Your organisation account is suspended"
        description="This account needs explicit reactivation before it can be used. Signing in will not reactivate it."
      >
        <Button variant="outline" nativeButton={false} render={<Link href="/signed-in" />}>
          Choose another organisation
        </Button>
      </AuthShell>
    );

  if (resolved.kind === "unavailable") {
    // A refused page and a missing page of an application the viewer may open both show that
    // application's own not-found page, in that application's installed theme; everything else
    // shows the fixed neutral fallback.
    if (resolved.experience === undefined) return unavailableFallback;
    return (
      <ApplicationExperiencePage
        page={resolved.experience.page}
        shells={resolved.experience.shells}
        theme={resolved.experience.theme}
        organizationName={organizationShortName}
        account={await loadAccount()}
        platformBlockReleases={platformBlockReleasesFor(
          resolved.experience.page,
          resolved.experience.shells,
        )}
        fieldInputControlReleases={FIELD_INPUT_CONTROL_RELEASES}
        platformThemeTokens={DEFAULT_PLATFORM_THEME_RELEASE.tokens}
      />
    );
  }

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
    if (projection.kind !== "available")
      throw new Error("Available organisation launcher read produced an unavailable projection");
    const launcherValues = permittedApplicationsToListValues(projection);
    const studioCreateAccess = await loadStudioCreateAccess(resolved.read.organizationId);
    const studio =
      studioCreateAccess.kind === "available" &&
      studioCreateAccess.organizationId === resolved.read.organizationId
        ? {
            href: `/studio/${studioCreateAccess.organizationId}/new`,
            placementId: organizationLauncherStudioPlacementId,
          }
        : undefined;
    const page = studio === undefined ? organizationLauncherPage : organizationLauncherStudioPage;

    return (
      <OrganizationLauncherPage
        page={page}
        shell={organizationLauncherShell}
        placementId={organizationLauncherPlacementId}
        values={launcherValues}
        organizationName={resolved.read.organizationShortName}
        account={await loadAccount()}
        openApplication={openApplication}
        launcherHref={launcherPath(tenantShortName, organizationShortName)}
        platformBlockReleases={platformBlockReleasesFor(page, organizationLauncherShell)}
        fieldInputControlReleases={FIELD_INPUT_CONTROL_RELEASES}
        platformThemeTokens={DEFAULT_PLATFORM_THEME_RELEASE.tokens}
        {...(studio === undefined ? {} : { studio })}
      />
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
  const parameters = await searchParams;
  // When the addressed page's shell shows the application switcher, its permitted-applications
  // read starts now, beside the page load, instead of after it. The read is cached for this
  // request, so the switcher below awaits this same read.
  const switcherPrefetch = switcherShownFor(resolved.installedContext, resolved.pageKey)
    ? loadPermittedApplicationsAtAddress(identity.session, tenantShortName, organizationShortName)
    : undefined;
  void switcherPrefetch?.catch(() => undefined);
  const loadedPage = await loadApplicationPage(
    identity.session,
    {
      tenantShortName,
      organizationShortName,
      read: resolved.read,
      application: resolved.application,
      pageKey: resolved.pageKey,
      ...(resolved.installedContext === undefined
        ? {}
        : { installedContext: resolved.installedContext }),
    },
    parameters,
  ).catch(async (error: unknown) => {
    await switcherPrefetch?.catch(() => undefined);
    throw error;
  });
  // A page that does not render joins the switcher read before returning, so it never outlives
  // this request's render.
  if (loadedPage.kind !== "available") await switcherPrefetch?.catch(() => undefined);
  const page = loadedPage;
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
  if (page.kind === "unavailable") notFound();
  const applicationSwitcherRead =
    page.model.applicationShell?.presentation.topBar.applicationSwitcher === true
      ? await loadPermittedApplicationsAtAddress(
          identity.session,
          tenantShortName,
          organizationShortName,
        )
      : undefined;
  if (applicationSwitcherRead?.kind === "temporarily_unavailable")
    console.error(
      `[application-shell] permitted applications unavailable: cause=${applicationSwitcherRead.cause ?? "cause_not_provided"}`,
    );
  const applicationSwitcherState =
    applicationSwitcherRead === undefined || applicationSwitcherRead.kind === "available"
      ? "available"
      : applicationSwitcherRead.kind === "temporarily_unavailable"
        ? "temporarily_unavailable"
        : "unavailable";
  const applicationSwitcherApplications =
    applicationSwitcherRead?.kind === "available"
      ? applicationSwitcherRead.applications.map((candidate) => ({
          key: candidate.key,
          name: candidate.name,
          homePageKey: candidate.homePageKey,
        }))
      : applicationSwitcherRead === undefined
        ? page.model.availableApplications
        : [];
  const applicationModel = {
    ...page.model,
    availableApplications: applicationSwitcherApplications,
  };
  const searchExpression =
    typeof parameters.q === "string"
      ? parameters.q === "" ? undefined : parameters.q
      : parameters.q === undefined ? undefined : "";
  // The installed context already says whether search is configured; only a search request reads.
  const search =
    searchExpression === undefined
      ? page.model.searchEnabled
        ? ({ kind: "available", expression: "", results: [], more: false } as const)
        : ({ kind: "disabled" } as const)
      : await loadApplicationSearch(
          identity.session,
          { tenantShortName, organizationShortName, applicationKey: resolved.application.key },
          searchExpression,
        );
  const searchPageSubject = recordIdSchema.safeParse(parameters.record_id);
  const adoptionOutcome =
    parameters.adoption === "recent_authentication_required"
      ? "A recent sign-in is required to adopt this release. Sign out, then sign in again with your email address and password before adopting. The current release is still in use."
      : parameters.adoption === "refused"
        ? "The release could not be adopted. The current release is still in use."
        : undefined;
  return (
    <ApplicationPageView
      model={applicationModel}
      platformBlockReleases={platformBlockReleasesFor(
        applicationModel.page,
        applicationModel.shells,
        applicationModel.applicationShell,
      )}
      fieldInputControlReleases={FIELD_INPUT_CONTROL_RELEASES}
      platformThemeTokens={DEFAULT_PLATFORM_THEME_RELEASE.tokens}
      onOpenApplication={openApplication}
      adoptReleaseAction={adoptRelease}
      applicationSwitcherState={applicationSwitcherState}
      account={accountWithName(resolved.read.accountDisplayName)}
      applicationSearch={search}
      applicationSearchPageSubject={searchPageSubject.success ? searchPageSubject.data : undefined}
      pageFeedback={
        adoptionOutcome === undefined ? undefined : (
          <Alert role="status" aria-live="polite" data-vortex-release-adoption="outcome">
            <AlertDescription>{adoptionOutcome}</AlertDescription>
          </Alert>
        )
      }
      guidedFormActions={{
        advance: advanceGuidedFormStepAction,
        confirm: confirmGuidedFormAction,
        abandon: abandonGuidedFormDraftAction,
      }}
    />
  );
}
