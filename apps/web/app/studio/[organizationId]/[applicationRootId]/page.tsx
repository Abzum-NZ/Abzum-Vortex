import { loadStudioApplicationDraft } from "../../../_lib/studio-application-draft";
import { StudioUnavailable } from "../../_components/studio-unavailable";
import { ApplicationDraftWorkspace } from "../../_components/application-draft-workspace";
import { findPinnedPlatformThemeRelease } from "../../_lib/pinned-platform-theme-release";
import {
  FIELD_INPUT_CONTROL_RELEASES,
  IMMUTABLE_PLATFORM_BLOCK_CATALOGUE,
} from "@vortex/platform/server";

export const dynamic = "force-dynamic";

export default async function StudioApplicationPage({ params, searchParams }: {
  params: Promise<{ organizationId: string; applicationRootId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ organizationId, applicationRootId }, { tab }] = await Promise.all([params, searchParams]);
  const result = await loadStudioApplicationDraft(organizationId, applicationRootId);
  if (result.kind !== "available")
    return <StudioUnavailable subject="Application draft" result={result} />;
  const pin = result.draft.source.body.theme.base;
  const themeRelease = findPinnedPlatformThemeRelease(pin);
  if (themeRelease === undefined)
    throw new Error(`Draft pins unknown platform theme ${pin.catalogue_theme_id}@${pin.release_version}`);
  return <ApplicationDraftWorkspace key={`${result.organizationId}:${result.draft.rootId}`}
    mode="existing" organizationId={result.organizationId} draft={result.draft} initialTab={tab}
    searchMetadata={result.searchMetadata} pageCompiledSlots={result.pageCompiledSlots} canvasFrames={result.canvasFrames} compileFailure={result.compileFailure}
    platformBlockCatalogue={IMMUTABLE_PLATFORM_BLOCK_CATALOGUE}
    fieldInputControlReleases={FIELD_INPUT_CONTROL_RELEASES}
    platformThemeTokens={themeRelease.tokens} />;
}
