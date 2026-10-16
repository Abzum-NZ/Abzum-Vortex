import { loadStudioApplicationDraft } from "../../../_lib/studio-application-draft";
import { organizationAddressPath } from "../../../_lib/address-paths";
import { loadOrganizationLauncher } from "../../../_lib/organization-context";
import { resolveIdentitySession } from "../../../auth/_lib/session-server";
import { StudioUnavailable } from "../../_components/studio-unavailable";
import { ApplicationDraftWorkspace, type StudioWorkspacePlace } from "../../_components/application-draft-workspace";
import { findPinnedPlatformThemeRelease } from "../../_lib/pinned-platform-theme-release";
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
  searchParams: Promise<{ tab?: string; section?: string }>;
}) {
  const [{ organizationId, applicationRootId }, { tab, section }] = await Promise.all([params, searchParams]);
  const result = await loadStudioApplicationDraft(organizationId, applicationRootId);
  if (result.kind !== "available")
    return <StudioUnavailable subject="Application draft" result={result} />;
  const pin = result.draft.source.body.theme.base;
  const themeRelease = findPinnedPlatformThemeRelease(pin);
  if (themeRelease === undefined)
    throw new Error(`Draft pins unknown platform theme ${pin.catalogue_theme_id}@${pin.release_version}`);
  const place = await loadWorkspacePlace(result.organizationId, result.draft.key);
  return <ApplicationDraftWorkspace key={`${result.organizationId}:${result.draft.rootId}`}
    mode="existing" organizationId={result.organizationId} draft={result.draft} place={place}
    initialTab={tab} initialSection={section}
    searchMetadata={result.searchMetadata} pageCompiledSlots={result.pageCompiledSlots} canvasFrames={result.canvasFrames} compileFailure={result.compileFailure}
    platformBlockCatalogue={IMMUTABLE_PLATFORM_BLOCK_CATALOGUE}
    fieldInputControlReleases={FIELD_INPUT_CONTROL_RELEASES}
    platformThemeTokens={themeRelease.tokens} />;
}
