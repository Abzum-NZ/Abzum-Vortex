import { loadHumanDefinitionPublicationDraft } from "../../../../../_lib/definition-publication";
import { StudioUnavailable } from "../../../../_components/studio-unavailable";
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
  if (result.kind !== "available") return <StudioUnavailable subject="Module publication" result={result} />;
  if (result.draft.kind !== "module")
    return <StudioUnavailable subject="Module publication" result={{ kind: "refused", reason: "draft_kind_mismatch" }} />;

  return (
    <ModulePublicationEditor
      draft={result.draft}
      prepare={prepareStudioModulePublication}
      publish={publishStudioModule}
    />
  );
}
