import type { ReactNode } from "react";
import Link from "next/link";
import { loadHumanDefinitionPublicationDraft } from "../../../../_lib/definition-publication";
import { loadStudioModuleTextFieldSettings } from "../../../../_lib/studio-module-field-edits";

export const dynamic = "force-dynamic";

export default async function StudioModuleLayout({ children, params }: {
  children: ReactNode;
  params: Promise<{ organizationId: string; moduleRootId: string }>;
}) {
  const { organizationId, moduleRootId } = await params;
  const [result, publication] = await Promise.all([
    loadStudioModuleTextFieldSettings(organizationId, moduleRootId),
    loadHumanDefinitionPublicationDraft(organizationId, moduleRootId, "module"),
  ]);
  const base = `/studio/modules/${encodeURIComponent(organizationId)}/${encodeURIComponent(moduleRootId)}`;
  const draft = result.kind === "available" ? result.draft
    : publication.kind === "available" && publication.draft.kind === "module" ? publication.draft
      : undefined;
  const canPublish = publication.kind === "available" && publication.draft.kind === "module";

  return <>
    {draft !== undefined ? <nav className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3" aria-label="Module tools">
      <Link className="text-sm underline" href={`/studio/${encodeURIComponent(organizationId)}`}>Studio</Link>
      <span className="text-sm font-medium">Module: {draft.source.body.name}</span>
      {result.kind === "available" ? <>
        <Link className="rounded-lg border px-3 py-2 text-sm" href={base}>
          Field labels
        </Link>
        <Link className="rounded-lg border px-3 py-2 text-sm" href={`${base}/fields`}>
          Text field settings
        </Link>
        <Link className="rounded-lg border px-3 py-2 text-sm" href={`${base}/before-save`}>
          Rules before saving
        </Link>
      </> : null}
      {canPublish ? <Link className="rounded-lg border px-3 py-2 text-sm" href={`${base}/publish`}>
        Publish module
      </Link> : null}
      <span className="text-xs text-muted-foreground">Your permissions are checked each time you open or save.</span>
    </nav> : <p className="border-b border-border px-6 py-3 text-sm" role="status">
      Module tools are unavailable for this account or draft.
    </p>}
    {children}
  </>;
}
