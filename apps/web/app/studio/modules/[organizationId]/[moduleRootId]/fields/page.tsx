import { loadStudioModuleTextFieldSettings } from "../../../../../_lib/studio-module-text-field-settings";
import { ModuleTextFieldSettingsEditor } from "../../../../_components/module-text-field-settings-editor";

export const dynamic = "force-dynamic";

export default async function StudioModuleTextFieldSettingsPage({ params }: {
  params: Promise<{ organizationId: string; moduleRootId: string }>;
}) {
  const { organizationId, moduleRootId } = await params;
  const result = await loadStudioModuleTextFieldSettings(organizationId, moduleRootId);
  if (result.kind !== "available") return <main className="mx-auto max-w-3xl space-y-3 p-6">
    <h1>Module text settings unavailable</h1>
    <p role="status">This Module draft is unavailable. Sign in with an account permitted to manage drafts and try again.</p>
  </main>;
  return <ModuleTextFieldSettingsEditor key={`${result.draft.organizationId}:${result.draft.rootId}`}
    draft={result.draft} fields={result.fields} />;
}
