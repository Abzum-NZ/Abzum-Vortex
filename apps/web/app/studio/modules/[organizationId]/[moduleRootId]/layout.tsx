import type { ReactNode } from "react";
import { loadStudioModuleTextFieldSettings } from "../../../../_lib/studio-module-text-field-settings";

export const dynamic = "force-dynamic";

export default async function StudioModuleLayout({ children, params }: {
  children: ReactNode;
  params: Promise<{ organizationId: string; moduleRootId: string }>;
}) {
  const { organizationId, moduleRootId } = await params;
  const result = await loadStudioModuleTextFieldSettings(organizationId, moduleRootId);
  const base = `/studio/modules/${encodeURIComponent(organizationId)}/${encodeURIComponent(moduleRootId)}`;

  return <>
    {result.kind === "available" ? <nav className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3" aria-label="Module draft editor">
      <span className="text-sm font-medium">Module draft: {result.draft.source.body.name}</span>
      <a className="rounded border border-border px-3 py-2 text-sm" href={base} target="_blank" rel="noopener noreferrer">
        Open field labels in a new tab
      </a>
      <a className="rounded border border-border px-3 py-2 text-sm" href={`${base}/fields`} target="_blank" rel="noopener noreferrer">
        Open text field settings in a new tab
      </a>
      <span className="text-xs text-muted-foreground">Each editor rechecks current permissions when it loads and saves.</span>
    </nav> : <p className="border-b border-border px-6 py-3 text-sm" role="status">
      Module editor navigation is unavailable for this account or draft.
    </p>}
    {children}
  </>;
}
