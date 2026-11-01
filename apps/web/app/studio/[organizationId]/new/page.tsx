import { loadStudioCreateAccess } from "../../../_lib/studio-application-draft";
import { continueStudioSession } from "../../_lib/studio-session";
import { StudioUnavailable } from "../../_components/studio-unavailable";
import { loadStudioFrame } from "../../_lib/studio-frame";
import { ApplicationDraftWorkspace } from "../../_components/application-draft-workspace";
import {
  DEFAULT_PLATFORM_THEME_RELEASE,
  FIELD_INPUT_CONTROL_RELEASES,
  IMMUTABLE_PLATFORM_BLOCK_CATALOGUE,
} from "@vortex/platform/server";

export const dynamic = "force-dynamic";

export default async function NewStudioApplicationPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  const session = await continueStudioSession();
  if (session.kind === "temporarily_unavailable")
    return <StudioUnavailable subject="New application" result={session} />;
  const result = await loadStudioCreateAccess(organizationId);
  if (result.kind !== "available")
    return <StudioUnavailable subject="New application" result={result} />;
  const frame = await loadStudioFrame(result.organizationId);
  if (frame.kind !== "available")
    return <StudioUnavailable subject="New application" result={frame} />;
  return (
    <ApplicationDraftWorkspace
      mode="new"
      frame={frame.frame}
      organizationId={result.organizationId}
      platformBlockCatalogue={IMMUTABLE_PLATFORM_BLOCK_CATALOGUE}
      fieldInputControlReleases={FIELD_INPUT_CONTROL_RELEASES}
      platformThemeTokens={DEFAULT_PLATFORM_THEME_RELEASE.tokens}
    />
  );
}
