import { loadStudioModuleFieldLabel } from "../../../../../_lib/studio-module-field-label";
import { ModulePublicationEditor } from "../../../../_components/module-publication-editor";
import { prepareStudioModulePublication, publishStudioModule } from "./actions";

export const dynamic = "force-dynamic";

export default async function StudioModulePublicationPage({
  params,
}: {
  params: Promise<{ organizationId: string; moduleRootId: string }>;
}) {
  const { organizationId, moduleRootId } = await params;
  const result = await loadStudioModuleFieldLabel(organizationId, moduleRootId);
  if (result.kind !== "available")
    return (
      <main className="mx-auto max-w-3xl space-y-3 p-6">
        <h1>Module publication unavailable</h1>
        <p role="status">
          This Module draft is unavailable. Sign in with an account permitted to manage drafts and
          try again.
        </p>
      </main>
    );

  return (
    <ModulePublicationEditor
      draft={result.draft}
      prepare={prepareStudioModulePublication}
      publish={publishStudioModule}
    />
  );
}
