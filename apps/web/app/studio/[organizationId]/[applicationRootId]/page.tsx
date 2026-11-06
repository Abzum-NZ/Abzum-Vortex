import { loadStudioApplicationDraft } from "../../../_lib/studio-application-draft";
import {
  loadOrganizationLauncher,
  loadPermittedApplicationsAtAddress,
} from "../../../_lib/organization-context";
import { resolveIdentitySessionWithEmail } from "../../../auth/_lib/session-server";
import { studioFrameOf } from "../../_lib/studio-frame";
import { resolveApplicationAddress } from "../../../_lib/application-address";
import { continueStudioSession } from "../../_lib/studio-session";
import { StudioUnavailable } from "../../_components/studio-unavailable";
import {
  ApplicationDraftWorkspace,
  type StudioNavigationTargets,
  type StudioWorkspacePlace,
} from "../../_components/application-draft-workspace";
import { studioViewRequest } from "../../_lib/studio-view-request";
import { loadStudioOrganizationHome } from "../../../_lib/studio-organization-home";
import { readApplicationReleaseStanding } from "../../../_lib/application-release-adoption";
import { readCurrentOrganizationAppStoreAddressAfterAuthorization } from "@vortex/platform/server";
import {
  organizationSelectionCandidateSchema,
  type ApplicationRootId,
} from "@vortex/platform/schema";
import { humanOrganizationRequests } from "../../../_lib/server-composition";

export const dynamic = "force-dynamic";

/**
 * The organisation's name and frame, the running application the toolbar opens, and where the
 * application stands in the organisation, which decides whether the toolbar offers Install or Upgrade.
 */
const loadWorkspacePlace = async (
  organizationId: string,
  applicationRootId: ApplicationRootId,
  applicationKey: string,
): Promise<
  | { kind: "available"; place: StudioWorkspacePlace }
  | { kind: "refused" | "temporarily_unavailable" }
> => {
  // Each answer that is not available is said by the page in the words of its kind; every read
  // below logs its own failure once, so the page adds a line only where no read did.
  const { resolution: resolved, email } = await resolveIdentitySessionWithEmail();
  // Not signed in.
  if (resolved.kind !== "active" || email === undefined) return { kind: "refused" };
  const launcher = await loadOrganizationLauncher(resolved.session);
  // A launcher read that failed for now is not a refusal: the person is told to try again.
  if (launcher.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
  const entry =
    launcher.kind === "available"
      ? launcher.entries.find((candidate) => candidate.organizationId === organizationId)
      : undefined;
  // The organisation is not one of the person's: an expected refusal, and no read logged it.
  if (entry === undefined) {
    console.info(
      `[studio] workspace place refused: organisation not in the launcher (${launcher.kind})`,
    );
    return { kind: "refused" };
  }
  // The installed applications are read beside the settings: neither needs the other.
  const applicationsRead = loadPermittedApplicationsAtAddress(
    resolved.session,
    entry.tenantShortName,
    entry.organizationShortName,
  );
  // A refusal below returns before this read is used; it must not become an unhandled rejection.
  void applicationsRead.catch(() => undefined);
  // The organisation's settings name the App Store; Studio never assumes one.
  const settings = await humanOrganizationRequests().run(
    resolved.session,
    organizationSelectionCandidateSchema.parse({ organizationId }),
    (transaction) => readCurrentOrganizationAppStoreAddressAfterAuthorization(transaction),
  );
  // The request runner logged a refused or failed read once.
  if (settings.kind !== "available")
    return { kind: settings.kind === "temporarily_unavailable" ? settings.kind : "refused" };
  // No App Store address, or one that names no application: an administrator sets it in the
  // organisation settings.
  if (settings.value === null || settings.value === "invalid") return { kind: "refused" };
  const applications = await applicationsRead;
  // Some of this read's refusals are answered before any request runs, so it is said here.
  if (applications.kind === "unavailable")
    console.info("[studio] installed applications could not be read: unavailable");
  else if (applications.kind === "temporarily_unavailable")
    console.error(
      `[studio] installed applications could not be read: ${applications.cause ?? "no cause"}`,
    );
  // The installed Studio release shapes the frame the editor shows.
  const studioApplicationEntry =
    applications.kind === "available"
      ? applications.applications.find((candidate) => candidate.key === settings.value)
      : undefined;
  // The Flows tab's Navigate targets are needed after the editor opens, not to open it: their
  // address reads start now, run beside the reads below, and reach the editor when they finish.
  const navigationTargets: StudioNavigationTargets =
    applications.kind !== "available"
      ? // Said once above, where the read failed; the editor is told it failed.
        Promise.resolve({ kind: "failed" } as const)
      : Promise.all(
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
        ).then((targets) => ({ kind: "ready", targets: targets.flat() }) as const);
  // Where the application stands in the organisation, with whether the builder may open and
  // install it: the facts the toolbar needs to offer Open the application, Install, Upgrade or none.
  // It does not wait for the Studio address below.
  const standingRead = readApplicationReleaseStanding(resolved.session, {
    tenantShortName: entry.tenantShortName,
    organizationShortName: entry.organizationShortName,
    organizationId: entry.organizationId,
    applicationRootId,
  });
  // Both reads run on past a refusal or a throw below; marking them handled keeps a rejection of
  // either from being unhandled (what the editor receives is unchanged).
  void Promise.allSettled([standingRead, navigationTargets]);
  // A read that failed for now is not an uninstalled Studio: the person is told to try again.
  if (applications.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
  const studioResolved =
    studioApplicationEntry === undefined
      ? undefined
      : await resolveApplicationAddress(
          resolved.session,
          entry.tenantShortName,
          entry.organizationShortName,
          studioApplicationEntry.key,
          studioApplicationEntry.homePageKey,
        );
  if (studioResolved?.kind === "temporarily_unavailable")
    return { kind: "temporarily_unavailable" };
  // Studio is not installed for the person in this organisation.
  if (
    studioApplicationEntry === undefined ||
    studioResolved?.kind !== "application_page" ||
    studioResolved.installedContext === undefined
  )
    return { kind: "refused" };
  const studioInstalled = {
    name: studioApplicationEntry.name,
    homePageKey: studioApplicationEntry.homePageKey,
    context: studioResolved.installedContext,
  };
  // The same read the Releases tab shows, so Studio never calls an installed application installable.
  const standing = await standingRead;
  return {
    kind: "available",
    place: {
      organizationName: entry.organizationDisplayName,
      frame: studioFrameOf(entry, email, studioInstalled),
      standing,
      navigationTargets,
    },
  };
};

export default async function StudioApplicationPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; applicationRootId: string }>;
  searchParams: Promise<{
    tab?: string;
    page?: string;
    section?: string;
    module?: string;
    record?: string;
  }>;
}) {
  const [{ organizationId, applicationRootId }, query] = await Promise.all([params, searchParams]);
  const { tab, page, section, module, record } = query;
  const session = await continueStudioSession();
  if (session.kind === "temporarily_unavailable")
    return <StudioUnavailable subject="Application draft" result={session} />;
  const initial = await loadStudioApplicationDraft(organizationId, applicationRootId);
  if (initial.kind !== "available")
    return <StudioUnavailable subject="Application draft" result={initial} />;
  const request = studioViewRequest(tab ?? "structure", null, initial.draft.source, page);
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
    loadWorkspacePlace(result.organizationId, result.draft.rootId, result.draft.key),
    loadStudioOrganizationHome(result.organizationId),
  ]);
  if (place.kind !== "available") {
    // Reload opens the address shown, its view included; a refusal offers none.
    const shown = new URLSearchParams(
      Object.entries(query).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ).toString();
    const address = `/studio/${organizationId}/${applicationRootId}`;
    return (
      <StudioUnavailable
        subject="App Store address"
        result={place}
        {...(place.kind === "temporarily_unavailable"
          ? { reloadHref: shown === "" ? address : `${address}?${shown}` }
          : {})}
      />
    );
  }
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
      initialRecordType={record}
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
