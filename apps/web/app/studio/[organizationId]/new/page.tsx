import { loadStudioCreateAccess } from "../../../_lib/studio-application-draft";
import { StudioUnavailable } from "../../_components/studio-unavailable";
import { ApplicationDraftWorkspace } from "../../_components/application-draft-workspace";
import {
  DEFAULT_PLATFORM_THEME_RELEASE,
  FIELD_INPUT_CONTROL_RELEASES,
  IMMUTABLE_PLATFORM_BLOCK_CATALOGUE,
} from "@vortex/platform/server";

export const dynamic = "force-dynamic";

export default async function NewStudioApplicationPage({ params }: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  const result = await loadStudioCreateAccess(organizationId);
  if (result.kind !== "available")
    return <StudioUnavailable subject="New application" result={result} />;
  return <ApplicationDraftWorkspace mode="new" organizationId={result.organizationId}
    platformBlockCatalogue={IMMUTABLE_PLATFORM_BLOCK_CATALOGUE}
    fieldInputControlReleases={FIELD_INPUT_CONTROL_RELEASES}
    platformThemeTokens={DEFAULT_PLATFORM_THEME_RELEASE.tokens} />;
}
