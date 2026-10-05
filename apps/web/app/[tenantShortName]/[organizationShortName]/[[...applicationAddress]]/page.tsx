import "server-only";

import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ApplicationInstallationCoordinatorError } from "@vortex/app";
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
import { Alert, AlertDescription } from "@vortex/ui/components/alert";
import { Button } from "@vortex/ui/components/button";
import { AuthShell } from "../../../auth/_components/auth-shell";
import { applicationHomeContinuationFromAddress } from "../../../auth/_lib/application-home-continuation";
import { continueSessionOrEnd } from "../../../auth/_lib/session-redirect";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";
import {
  getIdentityAuthorityConfiguration,
  getIdentityJourneyConfiguration,
} from "../../../auth/_lib/authority-configuration";
import {
  applicationPageAddressPath as addressPath,
  organizationAddressPath as launcherPath,
} from "../../../_lib/address-paths";
import { resolveApplicationAddress } from "../../../_lib/application-address";
import {
  loadApplicationPage,
  takeLocalPageProjectionResponseEvidence,
} from "../../../_lib/application-page";
import { adoptApplicationRelease } from "../../../_lib/application-release-adoption";
import {
  abandonGuidedFormDraftAction,
  advanceGuidedFormStepAction,
  confirmGuidedFormAction,
} from "./guided-form-actions";

export const dynamic = "force-dynamic";

const adoptionDiagnosticCoordinatorCodes = new Set<string>([
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

const adoptionDiagnosticCauseCodes = new Set<string>([
  ...adoptionDiagnosticCoordinatorCodes,
  "BUILDER_PERMISSION_REFUSED",
  "BUILDER_RECENT_AUTHENTICATION_REQUIRED",
  "BUILDER_AUTHORITY_UNAVAILABLE",
  "ORGANIZATION_ACCESS_DECISION_UNAVAILABLE",
  "INVALID_DEFINITION_READ_COMMAND",
  "DEFINITION_RELEASE_NOT_FOUND",
  "DEFINITION_CONTEXT_REFUSED",
  "DEFINITION_DEPENDENCY_UNAVAILABLE",
  "DEFINITION_RELEASE_INTEGRITY_FAILED",
  "DEFINITION_READ_FAILED",
]);

const adoptionDiagnosticSqlStates = new Set<string>([
  "22023", "42501", "P0002", "40001", "23503", "23505", "23514", "55000",
  "57014", "40P01", "57P01", "08000", "08001", "08003", "08006",
]);

/** Only a known coordinator exception can select the display-only authentication notice. */
const adoptionCoordinatorCode = (error: unknown): string => {
  try {
    if (!(error instanceof ApplicationInstallationCoordinatorError)) return "UNKNOWN";
    const code: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
    return typeof code === "string" && adoptionDiagnosticCoordinatorCodes.has(code)
      ? code
      : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
};

/** Temporary server-only observation; diagnostics must never change the adoption outcome. */
const diagnoseLocalAdoptionRefusal = (error: unknown): void => {
  try {
    if (
      process.env.VORTEX_LOCAL_ADOPTION_DIAGNOSTIC !== "1" ||
      process.env.NODE_ENV === "production" ||
      process.env.VORTEX_ENVIRONMENT !== "local"
    ) return;
    const journey = getIdentityJourneyConfiguration();
    const authority = getIdentityAuthorityConfiguration();
    if (
      authority.environment !== "local" ||
      new URL(journey.supabaseUrl).href !== "http://127.0.0.1:54321/" ||
      new URL(journey.siteUrl).href !== "http://127.0.0.1:3000/" ||
      authority.issuer !== "http://127.0.0.1:54321/auth/v1" ||
      authority.jwksUrl !== "http://127.0.0.1:54321/auth/v1/.well-known/jwks.json"
    ) return;

    const causes: string[] = [];
    let cause: unknown = error;
    for (let depth = 0; depth < 5 && cause instanceof Error; depth += 1) {
      // Own data descriptors avoid invoking arbitrary error accessors or coercing values.
      const code: unknown = Object.getOwnPropertyDescriptor(cause, "code")?.value;
      causes.push(
        typeof code !== "string" ? "NONE"
          : adoptionDiagnosticCauseCodes.has(code) ? code
            : adoptionDiagnosticSqlStates.has(code) ? code
              : /^[A-Z0-9]{5}$/.test(code) ? "OTHER" : "UNKNOWN",
      );
      cause = Object.getOwnPropertyDescriptor(cause, "cause")?.value;
    }
    console.error("VORTEX_LOCAL_ADOPTION_DIAGNOSTIC:" + JSON.stringify({
      stage: "ADOPTION_CATCH",
      code: adoptionCoordinatorCode(error),
      causes,
    }));
  } catch {
    // Configuration, inspection and logger failures preserve the original refusal.
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
      diagnoseLocalAdoptionRefusal(error);
      recentAuthenticationRequired =
        adoptionCoordinatorCode(error) === "APPLICATION_INSTALLATION_RECENT_AUTHENTICATION_REQUIRED";
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

  if (resolved.kind === "suspended_super_administrator_account")
    return (
      <AuthShell
        eyebrow="Organisation access"
        title="Your organisation account is suspended"
        description="This account needs explicit reactivation before it can be used. Signing in will not reactivate it."
      >
        <Link href="/signed-in">Choose another organisation</Link>
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
  if (page.kind === "unavailable") return unavailableFallback;
  const projectionResponseEvidence = takeLocalPageProjectionResponseEvidence(page.model);
  const adoption = page.model.adoption;
  // The outcome notice is display only: it never selects a release, and the page below always
  // renders whatever installation the server resolved for this request.
  const adoptionOutcome =
    parameters.adoption === "adopted"
      ? "The new release is now in use."
      : parameters.adoption === "recent_authentication_required"
        ? "A recent sign-in is required to adopt this release. Sign out, then sign in again with your email address and password before adopting. The current release is still in use."
        : parameters.adoption === "refused"
          ? "The release could not be adopted. The current release is still in use."
          : undefined;
  return (
    <ApplicationPageView
      model={page.model}
      onOpenApplication={openApplication}
      pageFeedback={adoption === undefined && adoptionOutcome === undefined &&
        projectionResponseEvidence === undefined ? undefined : (
        <>
          {projectionResponseEvidence === undefined ? null : (
            <span
              hidden
              aria-hidden="true"
              data-vortex-local-projection-response={JSON.stringify(projectionResponseEvidence)}
            />
          )}
          {adoptionOutcome === undefined ? null : (
            <Alert role="status" aria-live="polite" data-vortex-release-adoption="outcome">
              <AlertDescription>{adoptionOutcome}</AlertDescription>
            </Alert>
          )}
          {adoption === undefined ? null : (
            <Alert role="region" aria-label="Application release">
              <AlertDescription>
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
                    <Button type="submit">Adopt release {adoption.offeredReleaseVersion}</Button>
                  </form>
                </AlertDescription>
              </Alert>
            )}
          </>
        )}
        guidedFormActions={{
          advance: advanceGuidedFormStepAction,
          confirm: confirmGuidedFormAction,
          abandon: abandonGuidedFormDraftAction,
        }}
      />
  );
}
