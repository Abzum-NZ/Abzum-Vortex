import { loadStudioApplicationDraft } from "../../../_lib/studio-application-draft";
import { organizationAddressPath } from "../../../_lib/address-paths";
import { loadOrganizationLauncher } from "../../../_lib/organization-context";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";
import { StudioUnavailable } from "../../_components/studio-unavailable";
import { ApplicationDraftWorkspace, type StudioWorkspacePlace } from "../../_components/application-draft-workspace";
import { findPinnedPlatformThemeRelease } from "../../_lib/pinned-platform-theme-release";
import { loadStudioOrganizationHome } from "../../../_lib/studio-organization-home";
import { studioThemeOptions } from "../../_lib/studio-theme-catalogue";
import {
  FIELD_INPUT_CONTROL_RELEASES,
  IMMUTABLE_PLATFORM_BLOCK_CATALOGUE,
} from "@vortex/platform/server";

export const dynamic = "force-dynamic";

/** The organisation's name and the running application's address, for the top bar's breadcrumb and Back to app. */
const loadWorkspacePlace = async (organizationId: string, applicationKey: string): Promise<StudioWorkspacePlace> => {
  const resolved = await resolveIdentitySession();
  const launcher = resolved.kind === "active" ? await loadOrganizationLauncher(resolved.session) : undefined;
  const entry = launcher?.kind === "available"
    ? launcher.entries.find((candidate) => candidate.organizationId === organizationId) : undefined;
  if (entry === undefined) {
    console.error(`[studio] workspace place unavailable: session ${resolved.kind}, launcher ${launcher?.kind ?? "not read"}`);
    return { organizationName: "Organisation", applicationHref: undefined };
  }
  return {
    organizationName: entry.organizationDisplayName,
    applicationHref: `${organizationAddressPath(entry.tenantShortName, entry.organizationShortName)}/${encodeURIComponent(applicationKey)}`,
  };
};

export default async function StudioApplicationPage({ params, searchParams }: {
  params: Promise<{ organizationId: string; applicationRootId: string }>;
  searchParams: Promise<{ tab?: string; section?: string; module?: string }>;
}) {
  const [{ organizationId, applicationRootId }, { tab, section, module }] = await Promise.all([params, searchParams]);
  const result = await loadStudioApplicationDraft(organizationId, applicationRootId);
  if (result.kind !== "available")
    return <StudioUnavailable subject="Application draft" result={result} />;
  const pin = result.draft.source.body.theme.base;
  const themeRelease = findPinnedPlatformThemeRelease(pin);
  if (themeRelease === undefined)
    throw new Error(`Draft pins unknown platform theme ${pin.catalogue_theme_id}@${pin.release_version}`);
  const [place, home] = await Promise.all([
    loadWorkspacePlace(result.organizationId, result.draft.key),
    loadStudioOrganizationHome(result.organizationId),
  ]);
  // The owner of a used Module is named and linked from this list; without it the key is shown.
  if (home.kind !== "available") console.error(`[studio] application list for module owners unavailable: ${home.kind}`);
  const applications = home.kind === "available"
    ? home.roots.map((root) => ({ key: root.key, rootId: root.rootId, name: root.name })) : [];
  return <ApplicationDraftWorkspace key={`${result.organizationId}:${result.draft.rootId}`}
    mode="existing" organizationId={result.organizationId} draft={result.draft} place={place}
    themeOptions={studioThemeOptions}
    initialTab={tab} initialSection={section}
    initialModule={module} applications={applications}
    searchMetadata={result.searchMetadata} borrowedChoices={result.borrowedChoices} usedModules={result.usedModules} published={result.published} pageCompiledSlots={result.pageCompiledSlots} canvasFrames={result.canvasFrames} compileFailure={result.compileFailure}
    platformBlockCatalogue={IMMUTABLE_PLATFORM_BLOCK_CATALOGUE}
    fieldInputControlReleases={FIELD_INPUT_CONTROL_RELEASES}
    platformThemeTokens={themeRelease.tokens} />;
}
