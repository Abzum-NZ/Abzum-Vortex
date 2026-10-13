import { loadStudioModuleFieldLabel } from "../../../../../_lib/studio-module-field-label";
import { loadStudioModuleTextFieldSettings } from "../../../../../_lib/studio-module-text-field-settings";
import { ModuleFieldsWorkspace } from "../../../../_components/module-fields-workspace";

export const dynamic = "force-dynamic";

export default async function StudioModuleFieldsPage({ params }: {
  params: Promise<{ organizationId: string; moduleRootId: string }>;
}) {
  const { organizationId, moduleRootId } = await params;
  const [fieldsResult, textResult] = await Promise.all([
    loadStudioModuleFieldLabel(organizationId, moduleRootId),
    loadStudioModuleTextFieldSettings(organizationId, moduleRootId),
  ]);
  if (fieldsResult.kind !== "available" || textResult.kind !== "available") return <main className="mx-auto max-w-3xl space-y-3 p-6">
    <h1>Module fields unavailable</h1>
    <p role="status">{fieldsResult.kind === "temporarily_unavailable" || textResult.kind === "temporarily_unavailable"
      ? "The Module draft could not be read because of a platform problem. Try again in a moment."
      : "This Module draft is unavailable. Sign in with an account permitted to manage drafts and try again."}</p>
  </main>;
  return <ModuleFieldsWorkspace key={`${fieldsResult.draft.organizationId}:${fieldsResult.draft.rootId}`} draft={fieldsResult.draft} />;
}
