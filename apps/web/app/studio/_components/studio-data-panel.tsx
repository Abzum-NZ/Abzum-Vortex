"use client";
import type { ReactNode } from "react";
import type { ApplicationSourceDocument } from "@vortex/platform/schema";
import { Badge } from "@vortex/ui/components/badge";
import { Button } from "@vortex/ui/components/button";
import { StudioPanelShell } from "./studio-frame";

/**
 * The Data tab's panel: the modules this application owns, edited here in its draft, and the
 * modules it uses from other applications, which are read-only here. The application's search
 * settings follow below.
 */
export function StudioDataPanel({ hidden, source, open, onOpen, search }: Readonly<{
  hidden: boolean;
  source: ApplicationSourceDocument;
  /** The key of the module open in the centre. */
  open: string | null;
  onOpen: (moduleKey: string) => void;
  /** The application's search settings editor. */
  search: ReactNode;
}>) {
  const { modules, uses } = source.body;
  return <StudioPanelShell title="Data" hidden={hidden}
    description="The record types this application uses come from its modules. A module is part of the application that owns it, and is saved and published with it.">
    {modules.length === 0 && uses.length === 0 ? <p className="text-sm">This application has no modules yet.</p> : null}
    {modules.length === 0 ? null : <section aria-label="Modules this application owns" className="space-y-2">
      <h3 className="text-xs font-semibold uppercase text-muted-foreground">Owned here</h3>
      <ul className="list-none space-y-2">{modules.map((module) => {
        const current = open === module.key;
        return <li key={module.key} className="space-y-1 rounded-md border border-border bg-card p-3 text-card-foreground">
          <p className="text-sm font-medium">{module.name}</p>
          <p className="break-all text-xs text-muted-foreground">{module.key}
            {module.record_types.length === 0 ? "" : ` · ${module.record_types.map((record) => record.name).join(", ")}`}</p>
          <Button type="button" size="xs" variant={current ? "secondary" : "outline"} aria-pressed={current}
            onClick={() => onOpen(module.key)}>Fields</Button>
        </li>;
      })}</ul>
    </section>}
    {uses.length === 0 ? null : <section aria-label="Modules used from other applications" className="space-y-2">
      <h3 className="text-xs font-semibold uppercase text-muted-foreground">Used from other applications</h3>
      <ul className="list-none space-y-2">{uses.map((use) => {
        const current = open === use.module;
        return <li key={use.module} className="space-y-1 rounded-md border border-border bg-card p-3 text-card-foreground">
          <div className="flex flex-wrap items-center gap-2">
            <p className="break-all text-sm font-medium">{use.module}</p>
            <Badge variant="outline">Read-only</Badge>
          </div>
          <p className="break-all text-xs text-muted-foreground">Owned by {use.application}</p>
          <Button type="button" size="xs" variant={current ? "secondary" : "outline"} aria-pressed={current}
            onClick={() => onOpen(use.module)}>Details</Button>
        </li>;
      })}</ul>
    </section>}
    <section aria-label="Search" className="space-y-2 border-t border-border pt-3">{search}</section>
  </StudioPanelShell>;
}
