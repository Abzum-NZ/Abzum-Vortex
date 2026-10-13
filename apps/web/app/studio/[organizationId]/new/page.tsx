import { loadStudioCreateAccess } from "../../../_lib/studio-application-draft";
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
    return <main className="mx-auto max-w-3xl p-6"><h1>Studio unavailable</h1>
      <p role="status">This workspace is unavailable. Sign in with an account permitted to manage drafts and try again.</p></main>;
  return <ApplicationDraftWorkspace mode="new" organizationId={result.organizationId}
    platformBlockCatalogue={IMMUTABLE_PLATFORM_BLOCK_CATALOGUE}
    fieldInputControlReleases={FIELD_INPUT_CONTROL_RELEASES}
    platformThemeTokens={DEFAULT_PLATFORM_THEME_RELEASE.tokens} />;
}
