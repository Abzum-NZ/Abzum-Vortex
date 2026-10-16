"use client";
import Link from "next/link";
import { Button } from "@vortex/ui/components/button";
import { TechnicalDetails } from "@vortex/ui/components/technical-details";
import type { StudioApplicationSearchMetadata } from "../../_lib/studio-application-draft";

/** The Modules tab: the modules this application uses, each linking (in this tab) to the module's own draft. */
export function StudioModulesPanel({ metadata, refreshing, refreshDisabled, onRefresh }: Readonly<{
  /** Null while the saved bindings are not verified (unsaved edits, or the draft has not compiled). */
  metadata: StudioApplicationSearchMetadata | null;
  refreshing: boolean;
  refreshDisabled: boolean;
  onRefresh: () => void;
}>) {
  return <section className="space-y-3" aria-label="Modules">
    <h2 className="text-xl font-semibold">Modules this application uses</h2>
    <p className="text-sm text-muted-foreground">Open a module to edit its own draft, for example a field label. A module has its own saved versions, separate from this application.</p>
    {metadata === null
      ? <p role="status">Save your changes, then refresh to list the modules this application uses.</p>
      : metadata.modules.length === 0 ? <p>This application does not use any modules yet.</p>
      : <ul className="space-y-2">{metadata.modules.map((module) =>
        <li key={module.moduleRootId} className="space-y-1 rounded-xl border bg-card p-3 text-card-foreground">
          <p className="break-all font-medium">{module.key}</p>
          <p className="text-sm">Version {module.releaseVersion}</p>
          <Link className="text-sm underline"
            href={`/studio/modules/${encodeURIComponent(module.organizationId)}/${encodeURIComponent(module.moduleRootId)}`}>
            Open this module&apos;s draft</Link>
          <TechnicalDetails>
            <dl className="space-y-1 text-sm">
              <div><dt className="font-semibold">Release revision</dt><dd>{module.releaseRevision}</dd></div>
              <div><dt className="font-semibold">Content fingerprint</dt><dd className="break-all"><code>{module.contentFingerprint}</code></dd></div>
              <div><dt className="font-semibold">Resolution fingerprint</dt><dd className="break-all"><code>{module.resolutionFingerprint}</code></dd></div>
            </dl>
          </TechnicalDetails>
        </li>)}</ul>}
    <Button type="button" variant="outline" size="sm" onClick={onRefresh} disabled={refreshing || refreshDisabled}>
      Refresh the list</Button>
  </section>;
}
