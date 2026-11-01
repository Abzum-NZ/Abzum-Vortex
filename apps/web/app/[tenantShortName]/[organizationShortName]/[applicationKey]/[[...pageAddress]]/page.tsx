import "server-only";
import { withPageReadAttribution } from "../../../../_lib/page-read-attribution";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { splitProjectedPage } from "@vortex/platform/schema";
import type { ApplicationAccount, DisplaySemanticEvent } from "@vortex/ui";
import { DEFAULT_PLATFORM_THEME_RELEASE } from "@vortex/platform/server";
import { ApplicationExperiencePage } from "./_components/application-experience-page";
import { ApplicationPageView } from "./_components/application-page-view";
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
import { resolveIdentitySessionWithEmail } from "../../../../auth/_lib/session-server";
import { loadOrganizationLauncher } from "../../../../_lib/organization-context";
import {
  applicationPageAddressPath as addressPath,
  organizationAddressPath as launcherPath,
} from "../../../../_lib/address-paths";
import { resolveApplicationAddress } from "../../../../_lib/application-address";
import { loadApplicationPage } from "../../../../_lib/application-page";
import { runtimePreviewOf } from "@vortex/platform/server";
import { RuntimePreviewIdleFill } from "../../../../studio/_components/runtime-preview-idle-fill";
import {
  fieldInputControlReleasesFor,
  platformBlockReleasesFor,
} from "../../../../_lib/platform-block-releases";

export const dynamic = "force-dynamic";

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
    // Inside an application the viewer may open, a refused page says the role can't open it and
    // leads back to the application's home; a missing page shows the application's own not-found
    // page in its installed theme or, when it has none, says the page no longer exists. Everything
    // else shows the fixed neutral fallback.
    const permitted = "application" in resolved ? resolved : undefined;
    const experience = permitted?.page === "missing" ? permitted.experience : undefined;
    if (experience === undefined)
      return (
        <BarePage>
          <OrganizationAddressState
            context={context}
            state={
              permitted === undefined
                ? { kind: "unavailable", back: "organization" }
                : {
                    kind: permitted.page === "refused" ? "page_not_open" : "page_missing",
                    applicationName: permitted.application.name,
                    homeHref: addressPath(
                      tenantShortName,
                      organizationShortName,
                      permitted.application.key,
                      permitted.application.homePageKey,
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
        {/* The application's own not-found page for an address naming no page of it. */}
        <div className="contents" data-vortex-address-state="page_missing">
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
      />
    </>
  );
}
