import { loadStudioModuleFieldLabel } from "../../../../_lib/studio-module-field-label";
import { ModuleFieldLabelEditor } from "../../../_components/module-field-label-editor";

export const dynamic = "force-dynamic";

export default async function StudioModuleFieldLabelPage({ params }: {
  params: Promise<{ organizationId: string; moduleRootId: string }>;
}) {
  const { organizationId, moduleRootId } = await params;
  const result = await loadStudioModuleFieldLabel(organizationId, moduleRootId);
  if (result.kind !== "available") return <main className="mx-auto max-w-3xl space-y-3 p-6">
    <h1>Module draft unavailable</h1>
    <p role="status">This Module draft is unavailable. Sign in with an account permitted to manage drafts and try again.</p>
  </main>;
  return <ModuleFieldLabelEditor key={`${result.draft.organizationId}:${result.draft.rootId}`}
    draft={result.draft} fields={result.fields} />;
}
