import { loadStudioModuleFieldLabel } from "../../../../_lib/studio-module-field-edits";
import { StudioUnavailable } from "../../../_components/studio-unavailable";
import { ModuleFieldLabelEditor } from "../../../_components/module-field-label-editor";

export const dynamic = "force-dynamic";

export default async function StudioModuleFieldLabelPage({ params }: {
  params: Promise<{ organizationId: string; moduleRootId: string }>;
}) {
  const { organizationId, moduleRootId } = await params;
  const result = await loadStudioModuleFieldLabel(organizationId, moduleRootId);
  if (result.kind !== "available") return <StudioUnavailable subject="Module draft" result={result} />;
  return <ModuleFieldLabelEditor key={`${result.draft.organizationId}:${result.draft.rootId}`}
    draft={result.draft} fields={result.fields} />;
}
