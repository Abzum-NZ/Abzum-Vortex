import "server-only";
import { withPageReadAttribution } from "../../../../_lib/page-read-attribution";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { flowRefusalFeedbackSentences, splitProjectedPage } from "@vortex/platform/schema";
import type { ApplicationAccount, DisplaySemanticEvent } from "@vortex/ui";
import { DEFAULT_PLATFORM_THEME_RELEASE, DefinitionError } from "@vortex/platform/server";
import { Alert, AlertDescription } from "@vortex/ui/components/alert";
import { ApplicationExperiencePage } from "./_components/application-experience-page";
import { ApplicationPageView } from "./_components/application-page-view";
import { multiFactorPath } from "./_components/application-page-view/notices";
import { BarePage } from "../_components/bare-page";
import {
  OrganizationAddressState,
  PageSubjectNotFound,
  SignInTemporarilyUnavailable,
} from "../../_components/address-states";
import {
  applicationLauncherEventIds,
  openPermittedApplication,
} from "../../_components/open-application";
import { applicationPageContinuationFromAddress } from "../../../../auth/_lib/sign-in-continuation";
import { pageSubjectParameter } from "../../../../_lib/application-page/placement-helpers";
import { continueSessionOrEnd } from "../../../../auth/_lib/session-redirect";
import {
  resolveIdentitySession,
  resolveIdentitySessionWithEmail,
} from "../../../../auth/_lib/session-server";
import { loadOrganizationLauncher } from "../../../../_lib/organization-context";
import {
  applicationPageAddressPath as addressPath,
  organizationAddressPath as launcherPath,
} from "../../../../_lib/address-paths";
import { resolveApplicationAddress } from "../../../../_lib/application-address";
import { loadApplicationPage } from "../../../../_lib/application-page";
import { runtimePreviewOf } from "@vortex/platform/server";
import { RuntimePreviewIdleFill } from "../../../../studio/_components/runtime-preview-idle-fill";
import { adoptApplicationRelease } from "../../../../_lib/application-release-adoption";
import { mapWebError } from "../../../../_lib/web-error-mapper";
import {
  fieldInputControlReleasesFor,
  platformBlockReleasesFor,
} from "../../../../_lib/platform-block-releases";
import {
  abandonGuidedFormDraftAction,
  advanceGuidedFormStepAction,
  confirmGuidedFormAction,
} from "./guided-form-actions";

export const dynamic = "force-dynamic";

const adoptionCoordinatorCodes = new Set<string>([
  "INVALID_APPLICATION_INSTALLATION_COMMAND",
  "APPLICATION_INSTALLATION_REFUSED",
  "APPLICATION_INSTALLATION_PERMISSION_REFUSED",
  "APPLICATION_INSTALLATION_RECENT_AUTHENTICATION_REQUIRED",
  "APPLICATION_INSTALLATION_MULTI_FACTOR_REQUIRED",
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

type ApplicationAddressPageProps = Readonly<{
  params: Promise<{
    tenantShortName: string;
    organizationShortName: string;
    applicationKey: string;
    pageAddress?: string[];
  }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

/**
 * One application page: only its content. The application frame around it is the layout's, which
 * stays mounted while pages change. A state that is not a page of this application (a refusal, a
 * suspended account, an unavailable read) is shown on its own, over the frame.
 */
export default function ApplicationAddressPage(props: ApplicationAddressPageProps) {
  return withPageReadAttribution(() => readApplicationAddressPage(props));
}

async function readApplicationAddressPage({ params, searchParams }: ApplicationAddressPageProps) {
  const { tenantShortName, organizationShortName, applicationKey, pageAddress } = await params;
  const pageSegments = pageAddress ?? [];
  const parameters = await searchParams;
  const continuation = applicationPageContinuationFromAddress(
    tenantShortName,
    organizationShortName,
    [applicationKey, ...pageSegments],
    parameters[pageSubjectParameter],
  );
  const { resolution, email } = await resolveIdentitySessionWithEmail();
  const identity = await continueSessionOrEnd(resolution, continuation);
  // A read that cannot be made right now (an overloaded or stopped request) is retried at this same
  // address, so a transient failure never sends the person to another application.
  const query = new URLSearchParams(
    Object.entries(parameters).flatMap(([key, value]) =>
      (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(
        (entry) => [key, entry] as [string, string],
      ),
    ),
  ).toString();
  const retryHref = `${
    pageSegments[0] === undefined
      ? `${launcherPath(tenantShortName, organizationShortName)}/${encodeURIComponent(applicationKey)}`
      : addressPath(tenantShortName, organizationShortName, applicationKey, pageSegments[0])
  }${query === "" ? "" : `?${query}`}`;

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

    const addressedApplicationKey = String(formData.get("applicationKey") ?? "");
    const pageKey = String(formData.get("pageKey") ?? "");
    const offeredReleaseRevision = Number(formData.get("targetReleaseRevision"));
    const expectedActiveReleaseRevision = Number(formData.get("expectedActiveReleaseRevision"));

    const rechecked = await resolveApplicationAddress(
      currentIdentity.session,
      tenantShortName,
      organizationShortName,
      addressedApplicationKey,
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
    let multiFactorRequired = false;
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
          multiFactorRequired: coordinatorCode === "APPLICATION_INSTALLATION_MULTI_FACTOR_REQUIRED",
        },
      });
      recentAuthenticationRequired = refusal.recentAuthenticationRequired;
      multiFactorRequired = refusal.multiFactorRequired;
      refused = true;
    }
    // A refusal, a stale revision or a failed preparation changes nothing; the page keeps showing
    // the prior release. Only a committed switch revalidates the address.
    if (refused)
      redirect(
        `${back}?adoption=${multiFactorRequired ? "multi_factor_required" : recentAuthenticationRequired ? "recent_authentication_required" : "refused"}`,
      );
    revalidatePath(back);
    redirect(`${back}?adoption=adopted`);
  }

  if (identity.kind === "temporarily_unavailable")
    return (
      <BarePage>
        <SignInTemporarilyUnavailable retryHref={retryHref} />
      </BarePage>
    );

  if (email === undefined) throw new Error("Active identity session resolved without an email");
  const context = { session: identity.session, email, tenantShortName, organizationShortName };
  const temporarilyUnavailable = (
    <BarePage>
      <OrganizationAddressState
        context={context}
        state={{ kind: "temporarily_unavailable", retryHref }}
      />
    </BarePage>
  );
  if (pageSegments.length > 1)
    return (
      <BarePage>
        <OrganizationAddressState
          context={context}
          state={{ kind: "unavailable", back: "organization" }}
        />
      </BarePage>
    );

  const resolved = await resolveApplicationAddress(
    identity.session,
    tenantShortName,
    organizationShortName,
    applicationKey,
    pageSegments[0],
  );
  if (resolved.kind === "temporarily_unavailable") return temporarilyUnavailable;
  if (resolved.kind === "suspended_super_administrator_account")
    return (
      <BarePage>
        <OrganizationAddressState context={context} state={{ kind: "suspended" }} />
      </BarePage>
    );

  if (resolved.kind !== "application_page") {
    // A refused page and a missing page of an application the viewer may open both show that
    // application's own not-found page, in that application's installed theme, or, when it has
    // none, a refusal that leads back to its home page; everything else shows the fixed neutral
    // fallback.
    const experience = resolved.kind === "unavailable" ? resolved.experience : undefined;
    const permitted = resolved.kind === "unavailable" ? resolved.application : undefined;
    if (experience === undefined)
      return (
        <BarePage>
          <OrganizationAddressState
            context={context}
            state={
              permitted === undefined
                ? { kind: "unavailable", back: "organization" }
                : {
                    kind: "page_not_open",
                    applicationName: permitted.name,
                    homeHref: addressPath(
                      tenantShortName,
                      organizationShortName,
                      permitted.key,
                      permitted.homePageKey,
                    ),
                  }
            }
          />
        </BarePage>
      );
    const launcher = await loadOrganizationLauncher(identity.session);
    if (launcher.kind !== "available")
      throw new Error(`Organisation launcher unavailable for the account menu: ${launcher.kind}`);
    const organization = launcher.entries.find(
      (entry) =>
        entry.tenantShortName === tenantShortName &&
        entry.organizationShortName === organizationShortName,
    );
    if (organization === undefined)
      throw new Error("Organisation launcher does not list the addressed organisation");
    const displayName = organization.accountDisplayName;
    const account: ApplicationAccount =
      displayName === undefined ? { email } : { email, displayName };
    return (
      <BarePage>
        {/* The application's own page for an address its viewer cannot open (refused or missing). */}
        <div className="contents" data-vortex-address-state="page_not_open">
          <ApplicationExperiencePage
            page={experience.page}
            shells={experience.shells}
            theme={experience.theme}
            organizationName={organization.organizationDisplayName}
            organizationShortName={organization.organizationShortName}
            account={account}
            platformBlockReleases={platformBlockReleasesFor(experience.page, experience.shells)}
            fieldInputControlReleases={fieldInputControlReleasesFor(
              experience.page.composition,
              ...experience.shells.map((shell) => shell.layout),
            )}
            platformThemeTokens={DEFAULT_PLATFORM_THEME_RELEASE.tokens}
          />
        </div>
      </BarePage>
    );
  }

  if (pageSegments.length === 0)
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
      ...(resolved.installedContext === undefined
        ? {}
        : { installedContext: resolved.installedContext }),
      ...(resolved.navigation === undefined ? {} : { navigation: resolved.navigation }),
    },
    parameters,
    {
      streamPlacementReads: true,
      // Client page changes reuse the layout; a document already receives the frame's copy.
      includeNavigation: (await headers()).get("rsc") === "1",
    },
  );
  if (page.kind === "temporarily_unavailable") return temporarilyUnavailable;
  if (page.kind === "not_runnable")
    return (
      <BarePage>
        <OrganizationAddressState
          context={context}
          state={{
            kind: "preview_not_runnable",
            sentence: page.sentence,
            // Only a draft preview, which always has its installed context, cannot run.
            studioHref: `/studio/${encodeURIComponent(resolved.installedContext!.organizationId)}/${encodeURIComponent(resolved.application.applicationRootId)}`,
          }}
        />
      </BarePage>
    );
  // The page exists and may be opened, but its addressed record or parameters cannot be shown: the
  // state renders inside the application frame, which stays mounted around the page.
  if (page.kind === "unavailable")
    return (
      <PageSubjectNotFound
        applicationName={resolved.application.name}
        homeHref={addressPath(
          tenantShortName,
          organizationShortName,
          resolved.application.key,
          resolved.application.homePageKey,
        )}
      />
    );

  const launcherEvents = applicationLauncherEventIds(page.model.page.composition);
  async function openApplication(event: DisplaySemanticEvent): Promise<void> {
    "use server";
    await openPermittedApplication(tenantShortName, organizationShortName, event, launcherEvents);
  }

  // The page renders only its content; the frame around it is the shell part of the same
  // projection, which the layout shows (and which this page hands to the frame on a later change).
  const { frame, content } = splitProjectedPage(page.model.page, page.applicationShell);
  // The page runtime keeps the whole projection, so shell placements keep their data and events;
  // only the rendering is split between the frame and the content.
  const adoptionOutcome =
    parameters.adoption === "multi_factor_required"
      ? flowRefusalFeedbackSentences.multi_factor_required
      : parameters.adoption === "recent_authentication_required"
        ? "A recent sign-in is required to adopt this release. Sign out, then sign in again with your email address and password before adopting. The current release is still in use."
        : parameters.adoption === "refused"
          ? "The release could not be adopted. The current release is still in use."
          : undefined;
  const preview =
    resolved.installedContext === undefined
      ? undefined
      : runtimePreviewOf(resolved.installedContext);
  return (
    <>
      {preview === undefined ? null : (
        <RuntimePreviewIdleFill
          organizationId={resolved.installedContext!.organizationId}
          rootId={resolved.application.applicationRootId}
          draftRevision={preview.draftRevision}
          previewInstallationId={preview.previewInstallationId}
        />
      )}
      <ApplicationPageView
        model={page.model}
        content={content}
        frame={frame}
        platformBlockReleases={platformBlockReleasesFor(page.model.page)}
        fieldInputControlReleases={fieldInputControlReleasesFor(page.model.page.composition)}
        platformThemeTokens={DEFAULT_PLATFORM_THEME_RELEASE.tokens}
        onOpenApplication={openApplication}
        adoptReleaseAction={adoptRelease}
        pageFeedback={
          adoptionOutcome === undefined ? undefined : (
            <Alert role="status" aria-live="polite" data-vortex-release-adoption="outcome">
              <AlertDescription>
                {adoptionOutcome}
                {parameters.adoption === "multi_factor_required" ? (
                  <>
                    {" "}
                    <Link href={multiFactorPath}>Verify</Link>
                  </>
                ) : null}
              </AlertDescription>
            </Alert>
          )
        }
        guidedFormActions={{
          advance: advanceGuidedFormStepAction,
          confirm: confirmGuidedFormAction,
          abandon: abandonGuidedFormDraftAction,
        }}
      />
    </>
  );
}
