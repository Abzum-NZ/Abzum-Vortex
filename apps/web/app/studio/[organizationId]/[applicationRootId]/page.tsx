import { loadStudioApplicationDraft } from "../../../_lib/studio-application-draft";
import { resolveApplicationAddress } from "../../../_lib/application-address";
import { loadStudioFrameContext, type StudioFrameContext } from "../../_lib/studio-frame";
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
import type { ApplicationRootId } from "@vortex/platform/schema";

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
  | Exclude<StudioFrameContext, { kind: "available" }>
> => {
  const context = await loadStudioFrameContext(organizationId);
  if (context.kind !== "available") return context;
  const { session, entry, applications, frame } = context;
  // The Flows tab's Navigate targets are needed after the editor opens, not to open it: their
  // address reads start now, run beside the read below, and reach the editor when they finish.
  const navigationTargets: StudioNavigationTargets = Promise.all(
    applications.applications
      .filter((candidate) => candidate.key !== applicationKey)
      .map(async (candidate) => {
        const addressed = await resolveApplicationAddress(
          session,
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
  // A throw below leaves the targets unread; marking them handled keeps a rejection from being
  // unhandled (what the editor receives is unchanged).
  void Promise.allSettled([navigationTargets]);
  // Where the application stands in the organisation, with whether the builder may open and
  // install it: the facts the toolbar needs to offer Open the application, Install, Upgrade or none.
  const standing = await readApplicationReleaseStanding(session, {
    tenantShortName: entry.tenantShortName,
    organizationShortName: entry.organizationShortName,
    organizationId: entry.organizationId,
    applicationRootId,
  });
  return {
    kind: "available",
    place: {
      organizationName: entry.organizationDisplayName,
      frame,
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
  searchParams: Promise<{ tab?: string; section?: string; module?: string; record?: string }>;
}) {
  const [{ organizationId, applicationRootId }, query] = await Promise.all([params, searchParams]);
  const { tab, section, module, record } = query;
  const session = await continueStudioSession();
  if (session.kind === "temporarily_unavailable")
    return <StudioUnavailable subject="Application draft" result={session} />;
  const initial = await loadStudioApplicationDraft(organizationId, applicationRootId);
  if (initial.kind !== "available")
    return (
      <StudioUnavailable
        subject="Application draft"
        result={initial}
        organizationId={organizationId}
      />
    );
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
  // The draft moved between the two reads (an expected race): said once, and the editor is reloaded
  // as for any temporary failure.
  if (result.kind === "stale") {
    console.info("[studio] application draft moved while the editor opened: STUDIO_DRAFT_STALE");
    return (
      <StudioUnavailable
        subject="Application draft"
        result={{ kind: "temporarily_unavailable" }}
        organizationId={organizationId}
      />
    );
  }
  if (result.kind !== "available")
    return (
      <StudioUnavailable
        subject="Application draft"
        result={result}
        organizationId={organizationId}
      />
    );
  const view = result.views[0]!;
  const [place, home] = await Promise.all([
    loadWorkspacePlace(result.organizationId, result.draft.rootId, result.draft.key),
    loadStudioOrganizationHome(result.organizationId),
  ]);
  if (place.kind !== "available") return <StudioUnavailable subject="Studio" result={place} />;
  // The owner of a used Module is named and linked from this list; without it the key is shown.
  // The home read logged an answer that is not available, once.
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
