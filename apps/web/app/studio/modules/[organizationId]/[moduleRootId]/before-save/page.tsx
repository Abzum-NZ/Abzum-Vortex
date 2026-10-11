import { loadStudioModuleBeforeSaveCondition } from "../../../../../_lib/studio-module-before-save-condition";
import { ModuleBeforeSaveConditionEditor } from "../../../../_components/module-before-save-condition-editor";

export const dynamic = "force-dynamic";

export default async function StudioModuleBeforeSaveConditionsPage({ params }: {
  params: Promise<{ organizationId: string; moduleRootId: string }>;
}) {
  const { organizationId, moduleRootId } = await params;
  const initial = await loadStudioModuleBeforeSaveCondition(organizationId, moduleRootId);
  return (
    <ModuleBeforeSaveConditionEditor
      key={`${organizationId}:${moduleRootId}`}
      organizationId={organizationId}
      moduleRootId={moduleRootId}
      initial={initial}
    />
  );
}
