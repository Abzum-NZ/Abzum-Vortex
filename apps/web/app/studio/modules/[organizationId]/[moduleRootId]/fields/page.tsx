import {
  loadStudioModuleFieldLabel,
  loadStudioModuleTextFieldSettings,
} from "../../../../../_lib/studio-module-field-edits";
import { StudioUnavailable } from "../../../../_components/studio-unavailable";
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
  if (fieldsResult.kind !== "available") return <StudioUnavailable subject="Module fields" result={fieldsResult} />;
  if (textResult.kind !== "available") return <StudioUnavailable subject="Module fields" result={textResult} />;
  return <ModuleFieldsWorkspace key={`${fieldsResult.draft.organizationId}:${fieldsResult.draft.rootId}`} draft={fieldsResult.draft} />;
}
