import { loadHumanDefinitionPublicationDraft } from "../../../../../_lib/definition-publication";
import { ModulePublicationEditor } from "../../../../_components/module-publication-editor";
import { prepareStudioModulePublication, publishStudioModule } from "./actions";

export const dynamic = "force-dynamic";

export default async function StudioModulePublicationPage({
  params,
}: {
  params: Promise<{ organizationId: string; moduleRootId: string }>;
}) {
  const { organizationId, moduleRootId } = await params;
  const result = await loadHumanDefinitionPublicationDraft(organizationId, moduleRootId, "module");
  if (result.kind !== "available" || result.draft.kind !== "module")
    return (
      <main className="mx-auto max-w-3xl space-y-3 p-6">
        <h1>Module publication unavailable</h1>
        <p role="status">
          This Module draft is unavailable. Sign in with an account permitted to manage releases and
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
