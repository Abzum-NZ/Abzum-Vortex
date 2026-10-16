"use client";
import type { ReactNode } from "react";
import { Button } from "@vortex/ui/components/button";
import { TechnicalDetails } from "@vortex/ui/components/technical-details";
import { StudioPanelShell } from "./studio-frame";
import type { StudioApplicationSearchMetadata } from "../../_lib/studio-application-draft";
import { studioModuleTools, type StudioModuleTarget } from "../_lib/studio-module-tools";

/**
 * The Data tab's panel: the modules this application uses, each with the editors for its fields,
 * saved views and rules (opened in the centre), and the application's search settings below.
 */
export function StudioDataPanel({ hidden, metadata, refreshing, refreshDisabled, onRefresh, open, onOpen, search }: Readonly<{
  hidden: boolean;
  /** Null while the saved bindings are not verified (unsaved edits, or the draft has not compiled). */
  metadata: StudioApplicationSearchMetadata | null;
  refreshing: boolean;
  refreshDisabled: boolean;
  onRefresh: () => void;
  open: StudioModuleTarget | null;
  onOpen: (target: StudioModuleTarget) => void;
  /** The application's search settings editor. */
  search: ReactNode;
}>) {
  return <StudioPanelShell title="Data" hidden={hidden}
    description="The record types this application uses come from its modules. A module keeps its own saved versions."
    action={<Button type="button" variant="ghost" size="sm" onClick={onRefresh} disabled={refreshing || refreshDisabled}>Refresh</Button>}>
    {metadata === null
      ? <p role="status" className="text-sm">Save your changes, then refresh to list the modules this application uses.</p>
      : metadata.modules.length === 0 ? <p className="text-sm">This application does not use any modules yet.</p>
      : <ul className="list-none space-y-3" aria-label="Modules">{metadata.modules.map((module) => {
        const records = metadata.records.filter((record) => record.moduleRootId === module.moduleRootId);
        return <li key={module.moduleRootId} className="space-y-2 rounded-md border border-border bg-card p-3 text-card-foreground">
          <div>
            <p className="break-all text-sm font-medium">{module.key}</p>
            <p className="text-xs text-muted-foreground">Version {module.releaseVersion}
              {records.length === 0 ? "" : ` · ${records.map((record) => record.label).join(", ")}`}</p>
          </div>
          <div role="group" aria-label={`Edit ${module.key}`} className="flex flex-wrap gap-1">
            {studioModuleTools.map((tool) => {
              const current = open?.moduleRootId === module.moduleRootId && open.tool === tool.value;
              return <Button key={tool.value} type="button" size="xs" variant={current ? "secondary" : "outline"}
                aria-pressed={current}
                onClick={() => onOpen({ organizationId: module.organizationId, moduleRootId: module.moduleRootId, tool: tool.value })}>
                {tool.label}</Button>;
            })}
          </div>
          <TechnicalDetails>
            <dl className="space-y-1 text-xs">
              <div><dt className="font-semibold">Release revision</dt><dd>{module.releaseRevision}</dd></div>
              <div><dt className="font-semibold">Content fingerprint</dt><dd className="break-all"><code>{module.contentFingerprint}</code></dd></div>
              <div><dt className="font-semibold">Resolution fingerprint</dt><dd className="break-all"><code>{module.resolutionFingerprint}</code></dd></div>
            </dl>
          </TechnicalDetails>
        </li>;
      })}</ul>}
    <section aria-label="Search" className="space-y-2 border-t border-border pt-3">{search}</section>
  </StudioPanelShell>;
}
