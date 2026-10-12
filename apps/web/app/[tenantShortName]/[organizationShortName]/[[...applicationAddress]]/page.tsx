import "server-only";

import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { recordIdSchema } from "@vortex/platform/schema";
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
import { loadApplicationSearch } from "../../../_lib/application-search";
import { Alert, AlertDescription } from "@vortex/ui/components/alert";
import { Badge } from "@vortex/ui/components/badge";
import { Button } from "@vortex/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@vortex/ui/components/empty";
import { Icon } from "@vortex/ui/icons";
import { AuthShell } from "../../../auth/_components/auth-shell";
import { applicationHomeContinuationFromAddress } from "../../../auth/_lib/application-home-continuation";
import { continueSessionOrEnd } from "../../../auth/_lib/session-redirect";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";
import { loadPermittedApplicationsAtAddress } from "../../../_lib/organization-context";
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
import { DefinitionError } from "@web/platform-server";

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
    return typeof code === "string" && adoptionCoordinatorCodes.has(code)
      ? code
      : "UNKNOWN";
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
  const identity = await continueSessionOrEnd(
    await resolveIdentitySession(),
    applicationHome,
  );
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
      redirect(`${back}?adoption=${recentAuthenticationRequired ? "recent_authentication_required" : "refused"}`);
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
        identityId={identity.session.identityId}
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

    const studioCreateAccess = await loadStudioCreateAccess(resolved.read.organizationId);
    const studioCreateHref =
      studioCreateAccess.kind === "available" &&
      studioCreateAccess.organizationId === resolved.read.organizationId
        ? `/studio/${studioCreateAccess.organizationId}/new`
        : undefined;

    const projection = parsePermittedApplicationsLauncherProjection(resolved.read);
    const launcherValues =
      projection.kind === "available" ? permittedApplicationsToListValues(projection) : undefined;

    return (
      <main
        className="flex min-h-svh w-full flex-col bg-background text-foreground"
        {...createThemeRootProps(undefined)}
      >
        <style href="vortex-ui-styles" precedence="default">
          {ALL_UI_STYLES_CSS}
        </style>
        <header className="sticky top-0 z-10 border-b border-border bg-card/80 backdrop-blur-sm">
          <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4 sm:px-6">
            <div className="flex items-center gap-3">
              <Link
                href="/"
                className="text-base font-bold tracking-tight text-foreground hover:text-primary transition-colors"
              >
                Vortex
              </Link>
              <Badge variant="outline" className="text-xs">
                {resolved.read.organizationShortName}
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              {studioCreateHref === undefined ? null : (
                <Button variant="outline" size="sm" nativeButton={false} render={<Link href={studioCreateHref} />}>
                  Studio
                </Button>
              )}
              <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/signed-in" />}>
                Switch organisation
              </Button>
            </div>
          </div>
        </header>

        <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="w-fit text-xs uppercase">
                {resolved.read.tenantShortName}
              </Badge>
            </div>
            <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
              {resolved.read.organizationShortName}
            </h1>
            <p className="text-sm text-muted-foreground">
              Choose an application you can open.
            </p>
          </div>

          {launcherValues === undefined || launcherValues.rows.length === 0 ? (
            <Empty className="my-auto border border-dashed border-border py-12">
              <EmptyMedia variant="icon">
                <Icon name="grid" className="size-8 text-muted-foreground" />
              </EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>No applications available</EmptyTitle>
                <EmptyDescription>
                  No applications are available for this organisation.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="w-full">
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

        </div>
      </main>
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
  const page = await loadApplicationPage(
    identity.session,
    {
      tenantShortName,
      organizationShortName,
      read: resolved.read,
      application: resolved.application,
      pageKey: resolved.pageKey,
    },
    parameters,
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
  const search = await loadApplicationSearch(identity.session, {
    tenantShortName, organizationShortName, applicationKey: resolved.application.key,
  }, typeof parameters.q === "string" ? parameters.q === "" ? undefined : parameters.q : parameters.q === undefined ? undefined : "");
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
      onOpenApplication={openApplication}
      adoptReleaseAction={adoptRelease}
      applicationSwitcherState={applicationSwitcherState}
      identityId={identity.session.identityId}
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
