import { loadStudioModuleQueryFilter } from "../../../../../_lib/studio-module-query-filter";
import { ModuleQueryFilterEditor } from "../../../../_components/module-query-filter-editor";

export const dynamic = "force-dynamic";

export default async function StudioModuleQueryFiltersPage({ params }: {
  params: Promise<{ organizationId: string; moduleRootId: string }>;
}) {
  const { organizationId, moduleRootId } = await params;
  const initial = await loadStudioModuleQueryFilter(organizationId, moduleRootId);
  return (
    <ModuleQueryFilterEditor
      key={`${organizationId}:${moduleRootId}`}
      organizationId={organizationId}
      moduleRootId={moduleRootId}
      initial={initial}
    />
  );
}
