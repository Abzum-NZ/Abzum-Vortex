"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Button } from "@vortex/ui/components/button";
import type { ApplicationSourceDocument } from "@vortex/platform/schema";
import {
  studioFlowLabel, studioSemanticSelectionKey,
  type StudioFlowCreateChoices, type StudioFlowCreateCommand, type StudioFlowSelection,
} from "@vortex/ui/studio";
import { cn } from "@vortex/ui/lib/utils";
import { StudioPanelShell, StudioSearchBox } from "./studio-frame";
import { StudioNewFlowDialog } from "./studio-new-flow-dialog";
import type { StudioModuleOwnerApplication } from "./module-fields-editor";

/**
 * The Flows tab's list: the application's own flows, then each owned Module's flows, then the
 * Modules it only uses, whose flows belong to their owner and are changed in the owner's Studio.
 */

type FlowEntry = Readonly<{ selection: StudioFlowSelection; label: string }>;
type FlowGroup = Readonly<{ key: string; title: string; flows: readonly FlowEntry[] }>;

export function StudioFlowsPanel({ source, organizationId, applications, selectedKey, hidden, disabled,
  choose, createChoices, onCreate }: Readonly<{
  source: ApplicationSourceDocument;
  organizationId: string;
  applications: readonly StudioModuleOwnerApplication[];
  selectedKey: string;
  hidden: boolean;
  disabled: boolean;
  choose: (selection: StudioFlowSelection) => void;
  createChoices: StudioFlowCreateChoices;
  /** Creates a flow; resolves the refusal in words, or true. */
  onCreate: (command: StudioFlowCreateCommand) => string | true;
}>) {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const groups = useMemo((): FlowGroup[] => {
    const needle = query.trim().toLocaleLowerCase();
    const entries = (moduleKey: string | null, flows: ApplicationSourceDocument["body"]["flows"]) =>
      flows.map((flow) => ({ selection: { kind: "flow", flowAlias: flow.id, moduleKey } as const, label: studioFlowLabel(flow) }))
        .filter((entry) => needle.length === 0 || entry.label.toLocaleLowerCase().includes(needle))
        .sort((left, right) => left.label.localeCompare(right.label));
    return [
      { key: "application", title: "This application", flows: entries(null, source.body.flows) },
      ...source.body.modules.map((module) => ({ key: module.key, title: `Module ${module.name}`, flows: entries(module.key, module.flows) })),
    ];
  }, [source, query]);
  return <StudioPanelShell title="Flows" description="The workflows of this application and the modules it owns."
    hidden={hidden} action={<Button type="button" size="sm" variant="outline" disabled={disabled}
      onClick={() => setCreating(true)}>New flow</Button>}>
    <StudioSearchBox value={query} onChange={setQuery} placeholder="Find a flow" label="Find a flow" />
    {groups.map((group) => <section key={group.key} className="space-y-1" aria-label={group.title}>
      <h3 className="text-xs font-medium text-muted-foreground">{group.title}</h3>
      {group.flows.length === 0
        ? <p className="text-sm text-muted-foreground">{query.length > 0 ? "No flow matches." : "No flows yet."}</p>
        : <ul className="list-none space-y-0.5">
          {group.flows.map((entry) => {
            const key = studioSemanticSelectionKey(entry.selection);
            return <li key={key}>
              <Button type="button" variant="ghost" size="sm" disabled={disabled} aria-current={key === selectedKey ? "true" : undefined}
                className={cn("w-full justify-start truncate", key === selectedKey && "bg-accent text-accent-foreground")}
                onClick={() => choose(entry.selection)}>{entry.label}</Button>
            </li>;
          })}
        </ul>}
    </section>)}
    {source.body.uses.length > 0 && <section className="space-y-1" aria-label="Used modules">
      <h3 className="text-xs font-medium text-muted-foreground">Used modules (read-only)</h3>
      <ul className="list-none space-y-2">
        {source.body.uses.map((use) => {
          const owner = applications.find((application) => application.key === use.application);
          return <li key={use.module} className="text-sm text-muted-foreground">
            The flows of {use.module.split(".").pop()?.replace(/_/g, " ")} belong to {owner?.name ?? "the application that owns it"}.
            They run here as published and are changed in the owner&apos;s Studio.
            {owner === undefined ? null : <> <Link className="underline underline-offset-4"
              href={`/studio/${encodeURIComponent(organizationId)}/${encodeURIComponent(owner.rootId)}?tab=flows`}>
              Open {owner.name} in Studio</Link></>}
          </li>;
        })}
      </ul>
    </section>}
    <StudioNewFlowDialog open={creating} onOpenChange={setCreating} choices={createChoices} onCreate={onCreate} />
  </StudioPanelShell>;
}
