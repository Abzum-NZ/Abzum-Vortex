import { loadStudioApplicationDraft } from "../../../_lib/studio-application-draft";
import { applicationPageAddressPath, organizationAddressPath } from "../../../_lib/address-paths";
import {
  loadOrganizationLauncher,
  loadPermittedApplicationsAtAddress,
} from "../../../_lib/organization-context";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";
import { resolveApplicationAddress } from "../../../_lib/application-address";
import { continueStudioSession } from "../../_lib/studio-session";
import { StudioUnavailable } from "../../_components/studio-unavailable";
import {
  ApplicationDraftWorkspace,
  type StudioWorkspacePlace,
} from "../../_components/application-draft-workspace";
import { studioViewRequest } from "../../_lib/studio-view-request";
import { loadStudioOrganizationHome } from "../../../_lib/studio-organization-home";
import { readCurrentOrganizationAppStoreAddressAfterAuthorization } from "@vortex/platform/server";
import { organizationSelectionCandidateSchema } from "@vortex/platform/schema";
import { humanOrganizationRequests } from "../../../_lib/server-composition";

export const dynamic = "force-dynamic";

/**
 * The organisation's name and addresses: the running application, for the breadcrumb and Back to app,
 * and the App Store, which a publish points to for installing or upgrading.
 */
const loadWorkspacePlace = async (
  organizationId: string,
  applicationKey: string,
): Promise<
  | { kind: "available"; place: StudioWorkspacePlace }
  | { kind: "refused" | "temporarily_unavailable"; reason: string }
> => {
  const resolved = await resolveIdentitySession();
  if (resolved.kind !== "active") return { kind: "refused", reason: "Sign in to open Studio." };
  const launcher = await loadOrganizationLauncher(resolved.session);
  const entry =
    launcher?.kind === "available"
      ? launcher.entries.find((candidate) => candidate.organizationId === organizationId)
      : undefined;
  if (entry === undefined) {
    console.error(
      `[studio] workspace place unavailable: session ${resolved.kind}, launcher ${launcher?.kind ?? "not read"}`,
    );
    return { kind: "refused", reason: "This organisation is not available to your account." };
  }
  // The organisation's settings name the App Store; Studio never assumes one.
  const settings = await humanOrganizationRequests().run(
    resolved.session,
    organizationSelectionCandidateSchema.parse({ organizationId }),
    (transaction) => readCurrentOrganizationAppStoreAddressAfterAuthorization(transaction),
  );
  if (settings.kind === "temporarily_unavailable") {
    console.error(
      `[studio] App Store address read unavailable: ${settings.databaseCode ?? settings.cause ?? "unknown"}`,
    );
    return {
      kind: "temporarily_unavailable",
      reason: "The organisation's App Store address could not be read. Try again shortly.",
    };
  }
  if (settings.kind !== "available") {
    console.error(
      `[studio] App Store address read refused: ${settings.code ?? settings.cause ?? "no cause"}`,
    );
    return {
      kind: "refused",
      reason: "You do not have access to this organisation's App Store address.",
    };
  }
  if (settings.value === null)
    return {
      kind: "refused",
      reason:
        "This organisation has no App Store address. An organisation administrator sets it in the organisation settings.",
    };
  if (settings.value === "invalid")
    return {
      kind: "refused",
      reason:
        "This organisation's App Store address is not an application address. An organisation administrator corrects it in the organisation settings.",
    };
  const organizationPath = organizationAddressPath(
    entry.tenantShortName,
    entry.organizationShortName,
  );
  // Whether this application is installed in the organisation decides Back to app vs Install.
  const applications = await loadPermittedApplicationsAtAddress(
    resolved.session,
    entry.tenantShortName,
    entry.organizationShortName,
  );
  if (applications.kind !== "available")
    console.error(
      `[studio] installed applications could not be read: ${applications.kind}${applications.kind === "temporarily_unavailable" && applications.cause !== undefined ? ` (${applications.cause})` : ""}`,
    );
  // Links name an installed application's home page, never its address that would redirect there.
  const pathOf = (key: string): string => {
    const application =
      applications.kind === "available"
        ? applications.applications.find((candidate) => candidate.key === key)
        : undefined;
    return application === undefined
      ? `${organizationPath}/${encodeURIComponent(key)}`
      : applicationPageAddressPath(
          entry.tenantShortName,
          entry.organizationShortName,
          application.key,
          application.homePageKey,
        );
  };
  const installed =
    applications.kind === "available" &&
    applications.applications.some((candidate) => candidate.key === applicationKey);
  // The other applications the builder may open, with the pages they may open there, for a
  // Navigate step that opens one of them.
  const navigationTargets =
    applications.kind !== "available"
      ? []
      : (
          await Promise.all(
            applications.applications
              .filter((candidate) => candidate.key !== applicationKey)
              .map(async (candidate) => {
                const addressed = await resolveApplicationAddress(
                  resolved.session,
                  entry.tenantShortName,
                  entry.organizationShortName,
                  candidate.key,
                );
                return addressed.kind === "application_page"
                  ? [
                      {
                        key: candidate.key,
                        label: candidate.name,
                        homePageKey: candidate.homePageKey,
                        pageKeys: addressed.application.pageKeys,
                      },
                    ]
                  : [];
              }),
          )
        ).flat();
  return {
    kind: "available",
    place: {
      organizationName: entry.organizationDisplayName,
      applicationHref: pathOf(applicationKey),
      appStoreHref: pathOf(settings.value),
      installed,
      navigationTargets,
    },
  };
};

export default async function StudioApplicationPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; applicationRootId: string }>;
  searchParams: Promise<{ tab?: string; section?: string; module?: string }>;
}) {
  const [{ organizationId, applicationRootId }, { tab, section, module }] = await Promise.all([
    params,
    searchParams,
  ]);
  const session = await continueStudioSession();
  if (session.kind === "temporarily_unavailable")
    return <StudioUnavailable subject="Application draft" result={session} />;
  const initial = await loadStudioApplicationDraft(organizationId, applicationRootId);
  if (initial.kind !== "available")
    return <StudioUnavailable subject="Application draft" result={initial} />;
  const request = studioViewRequest(tab ?? "structure", null, initial.draft.source);
  const result =
    request.kind === "source"
      ? initial
      : await loadStudioApplicationDraft(
          organizationId,
          applicationRootId,
          [request],
          initial.draft.draftRevision,
        );
  if (result.kind !== "available")
    return <StudioUnavailable subject="Application draft" result={result} />;
  const view = result.views[0]!;
  const [place, home] = await Promise.all([
    loadWorkspacePlace(result.organizationId, result.draft.key),
    loadStudioOrganizationHome(result.organizationId),
  ]);
  if (place.kind !== "available")
    return (
      <StudioUnavailable
        subject="App Store address"
        result={{ kind: place.kind, reason: place.reason }}
      />
    );
  // The owner of a used Module is named and linked from this list; without it the key is shown.
  if (home.kind !== "available")
    console.error(`[studio] application list for module owners unavailable: ${home.kind}`);
  const applications =
    home.kind === "available"
      ? home.roots.map((root) => ({ key: root.key, rootId: root.rootId, name: root.name }))
      : [];
  return (
    <ApplicationDraftWorkspace
      key={`${result.organizationId}:${result.draft.rootId}`}
      mode="existing"
      organizationId={result.organizationId}
      draft={result.draft}
      place={place.place}
      initialTab={tab}
      initialSection={section}
      initialModule={module}
      applications={applications}
      initialView={{
        identityReservations: view.identityReservations,
        request: view.request,
        catalogue: result.catalogue,
        previewShape: result.previewShape,
        themeOptions: view.themeOptions,
        fieldInputControlReleases: view.fieldInputControlReleases,
        platformThemeTokens: view.platformThemeTokens,
        compiledFields: view.compiledFields,
        borrowedChoices: view.borrowedChoices,
        usedModules: view.usedModules,
        published: view.published,
        peopleDirectory: view.peopleDirectory,
        slots: view.pageCompiledSlots,
        frames: view.canvasFrames,
        flowPlacements: view.flowPlacements,
        failure: view.compileFailure,
      }}
    />
  );
}
