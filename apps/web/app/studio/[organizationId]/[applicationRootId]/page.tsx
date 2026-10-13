import { loadStudioApplicationDraft } from "../../../_lib/studio-application-draft";
import { ApplicationDraftWorkspace } from "../../_components/application-draft-workspace";
import { findPinnedPlatformThemeRelease } from "../../_lib/pinned-platform-theme-release";
import {
  FIELD_INPUT_CONTROL_RELEASES,
  IMMUTABLE_PLATFORM_BLOCK_CATALOGUE,
} from "@vortex/platform/server";

export const dynamic = "force-dynamic";

export default async function StudioApplicationPage({ params }: {
  params: Promise<{ organizationId: string; applicationRootId: string }>;
}) {
  const { organizationId, applicationRootId } = await params;
  const result = await loadStudioApplicationDraft(organizationId, applicationRootId);
  if (result.kind !== "available")
    return <main className="mx-auto max-w-3xl p-6"><h1>Studio unavailable</h1>
      <p role="status">This draft is unavailable. Sign in with an account permitted to manage drafts and try again.</p></main>;
  const pin = result.draft.source.body.theme.base;
  const themeRelease = findPinnedPlatformThemeRelease(pin);
  if (themeRelease === undefined)
    throw new Error(`Draft pins unknown platform theme ${pin.catalogue_theme_id}@${pin.release_version}`);
  return <ApplicationDraftWorkspace key={`${result.organizationId}:${result.draft.rootId}`}
    mode="existing" organizationId={result.organizationId} draft={result.draft}
    searchMetadata={result.searchMetadata} pageCompiledSlots={result.pageCompiledSlots}
    platformBlockCatalogue={IMMUTABLE_PLATFORM_BLOCK_CATALOGUE}
    fieldInputControlReleases={FIELD_INPUT_CONTROL_RELEASES}
    platformThemeTokens={themeRelease.tokens} />;
}
