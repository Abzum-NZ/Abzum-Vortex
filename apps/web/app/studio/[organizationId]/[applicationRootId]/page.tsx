import { loadStudioApplicationDraft } from "../../../_lib/studio-application-draft";
import { organizationAddressPath } from "../../../_lib/address-paths";
import { loadOrganizationLauncher } from "../../../_lib/organization-context";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";
import { continueStudioSession } from "../../_lib/studio-session";
import { StudioUnavailable } from "../../_components/studio-unavailable";
import {
  ApplicationDraftWorkspace,
  type StudioWorkspacePlace,
} from "../../_components/application-draft-workspace";
import { studioViewRequest } from "../../_lib/studio-view-request";
import { loadStudioOrganizationHome } from "../../../_lib/studio-organization-home";

export const dynamic = "force-dynamic";

/** The App Store, the one place an organisation installs and upgrades its applications. */
const appStoreKey = "vortex.app.app_store";

/**
 * The organisation's name and addresses: the running application, for the breadcrumb and Back to app,
 * and the App Store, which a publish points to for installing or upgrading.
 */
const loadWorkspacePlace = async (
  organizationId: string,
  applicationKey: string,
): Promise<StudioWorkspacePlace> => {
  const resolved = await resolveIdentitySession();
  const launcher =
    resolved.kind === "active" ? await loadOrganizationLauncher(resolved.session) : undefined;
  const entry =
    launcher?.kind === "available"
      ? launcher.entries.find((candidate) => candidate.organizationId === organizationId)
      : undefined;
  if (entry === undefined) {
    console.error(
      `[studio] workspace place unavailable: session ${resolved.kind}, launcher ${launcher?.kind ?? "not read"}`,
    );
    return {
      organizationName: "Organisation",
      applicationHref: undefined,
      appStoreHref: undefined,
    };
  }
  const organizationPath = organizationAddressPath(
    entry.tenantShortName,
    entry.organizationShortName,
  );
  return {
    organizationName: entry.organizationDisplayName,
    applicationHref: `${organizationPath}/${encodeURIComponent(applicationKey)}`,
    appStoreHref: `${organizationPath}/${encodeURIComponent(appStoreKey)}`,
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
      place={place}
      initialTab={tab}
      initialSection={section}
      initialModule={module}
      applications={applications}
      initialView={{
        request: view.request,
        catalogue: result.catalogue,
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
        failure: view.compileFailure,
      }}
    />
  );
}
