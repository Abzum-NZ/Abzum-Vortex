"use client";
import { useMemo, useState, type ReactNode } from "react";
import { Icon } from "@vortex/ui";
import { Badge } from "@vortex/ui/components/badge";
import { Button } from "@vortex/ui/components/button";
import { StudioPanelShell, StudioSearchBox } from "./studio-frame";
import type { StudioModuleOwnerApplication } from "./module-fields-editor";
import type { StudioDataModule, StudioDataRecordType, StudioDataSelection } from "../_lib/studio-data-model";

const sameSelection = (left: StudioDataSelection | null, right: StudioDataSelection): boolean =>
  left !== null && JSON.stringify(left) === JSON.stringify(right);

function TreeButton({ label, detail, selected, disabled, onClick }: Readonly<{
  label: string; detail?: string | undefined; selected: boolean; disabled: boolean; onClick: () => void;
}>) {
  return <Button type="button" variant={selected ? "secondary" : "ghost"} size="sm" disabled={disabled} aria-pressed={selected}
    className="h-auto min-w-0 flex-1 justify-start whitespace-normal py-1 text-left" onClick={onClick}>
    <span className="min-w-0 break-words">{label}</span>
    {detail === undefined ? null : <span className="ml-auto shrink-0 text-xs text-muted-foreground">{detail}</span>}
  </Button>;
}

function RecordTypeNode({ module, record, selected, expanded, onToggle, onSelect, disabled }: Readonly<{
  module: StudioDataModule; record: StudioDataRecordType; selected: StudioDataSelection | null;
  expanded: boolean; onToggle: () => void; onSelect: (selection: StudioDataSelection) => void; disabled: boolean;
}>) {
  const queries = module.queries.filter((query) => query.recordKey === record.key);
  return <li className="space-y-1">
    <div className="flex items-center gap-1">
      <Button type="button" variant="ghost" size="icon-xs" aria-expanded={expanded}
        aria-label={`${expanded ? "Hide" : "Show"} the fields of ${record.name}`} onClick={onToggle}>
        <Icon name={expanded ? "chevron-down" : "chevron-right"} />
      </Button>
      <TreeButton label={record.pluralName} detail={`${record.fields.length} fields`} disabled={disabled}
        selected={sameSelection(selected, { kind: "record_type", moduleKey: module.key, recordKey: record.key })}
        onClick={() => onSelect({ kind: "record_type", moduleKey: module.key, recordKey: record.key })} />
    </div>
    {expanded && <ul className="ml-3 list-none space-y-1 border-l border-border pl-3" aria-label={`Fields and queries of ${record.name}`}>
      {record.fields.map((field) => <li key={field.key} className="flex">
        <TreeButton label={field.label} detail={field.key === record.titleFieldKey ? "Title" : undefined} disabled={disabled}
          selected={sameSelection(selected, { kind: "field", moduleKey: module.key, recordKey: record.key, fieldKey: field.key })}
          onClick={() => onSelect({ kind: "field", moduleKey: module.key, recordKey: record.key, fieldKey: field.key })} />
      </li>)}
      {queries.map((query) => <li key={`query:${query.key}`} className="flex">
        <TreeButton label={query.label} detail="Query" disabled={disabled}
          selected={sameSelection(selected, { kind: "query", moduleKey: module.key, queryKey: query.key })}
          onClick={() => onSelect({ kind: "query", moduleKey: module.key, queryKey: query.key })} />
      </li>)}
    </ul>}
  </li>;
}

function ModuleNode({ module, owner, selected, expanded, onToggle, onSelect, disabled }: Readonly<{
  module: StudioDataModule; owner: string | undefined; selected: StudioDataSelection | null;
  expanded: ReadonlySet<string>; onToggle: (key: string) => void; onSelect: (selection: StudioDataSelection) => void;
  disabled: boolean;
}>) {
  return <li className="space-y-1">
    <div className="flex flex-wrap items-center gap-1">
      <TreeButton label={module.name} disabled={disabled}
        selected={sameSelection(selected, { kind: "module", moduleKey: module.key })}
        onClick={() => onSelect({ kind: "module", moduleKey: module.key })} />
      {owner === undefined ? null : <Badge variant="outline">Read-only</Badge>}
    </div>
    {owner === undefined ? null : <p className="text-xs text-muted-foreground">Owned by {owner}. Change it in its owner&apos;s Studio.</p>}
    <ul className="list-none space-y-1 border-l border-border pl-2" aria-label={`Record types of ${module.name}`}>
      {module.recordTypes.map((record) => {
        const key = `${module.key}:${record.key}`;
        return <RecordTypeNode key={record.key} module={module} record={record} selected={selected} disabled={disabled}
          expanded={expanded.has(key)} onToggle={() => onToggle(key)} onSelect={onSelect} />;
      })}
    </ul>
  </li>;
}

/** Keeps the modules, record types and fields whose names match the search, with what leads to them. */
const filterModules = (modules: readonly StudioDataModule[], query: string): readonly StudioDataModule[] => {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return modules;
  const matches = (text: string) => text.toLocaleLowerCase().includes(needle);
  return modules.flatMap((module) => {
    if (matches(module.name)) return [module];
    const recordTypes = module.recordTypes.flatMap((record) => {
      if (matches(record.name) || matches(record.pluralName)) return [record];
      const fields = record.fields.filter((field) => matches(field.label));
      return fields.length === 0 ? [] : [{ ...record, fields }];
    });
    return recordTypes.length === 0 ? [] : [{ ...module, recordTypes }];
  });
};

/**
 * The Data tab's tree: the modules this application owns, their record types and each record
 * type's fields and queries, then the modules it uses from other applications, read-only. The
 * application's search settings follow below.
 */
export function StudioDataPanel({ hidden, owned, used, applications, selected, onSelect, onCreate, disabled, search }: Readonly<{
  hidden: boolean;
  /** The modules the draft owns. */
  owned: readonly StudioDataModule[];
  /** The modules the application uses, as their installed release defines them; null while unknown. */
  used: readonly StudioDataModule[] | null;
  /** The organisation's applications, to name the owner of a used module. */
  applications: readonly StudioModuleOwnerApplication[];
  selected: StudioDataSelection | null;
  onSelect: (selection: StudioDataSelection) => void;
  /** Opens the new record type form. */
  onCreate: () => void;
  disabled: boolean;
  /** The application's search settings editor. */
  search: ReactNode;
}>) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(
    selected === null || selected.kind === "module" || selected.kind === "query" ? [] : [`${selected.moduleKey}:${selected.recordKey}`]));
  const toggle = (key: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const choose = (selection: StudioDataSelection) => {
    if (selection.kind === "record_type" || selection.kind === "field")
      setExpanded((current) => new Set([...current, `${selection.moduleKey}:${selection.recordKey}`]));
    onSelect(selection);
  };
  const ownedShown = useMemo(() => filterModules(owned, query), [owned, query]);
  const usedShown = useMemo(() => filterModules(used ?? [], query), [used, query]);
  const searching = query.trim() !== "";
  const expandedShown = searching
    ? new Set([...ownedShown, ...usedShown].flatMap((module) => module.recordTypes.map((record) => `${module.key}:${record.key}`)))
    : expanded;
  const ownerName = (key: string | undefined) => applications.find((application) => application.key === key)?.name ?? key;
  return <StudioPanelShell title="Data" hidden={hidden}
    description="The record types of this application, with their fields and queries."
    action={<Button type="button" size="xs" onClick={onCreate} disabled={disabled}><Icon name="plus" />Record type</Button>}>
    <StudioSearchBox value={query} onChange={setQuery} placeholder="Find a record type or field" label="Find a record type or field" />
    {owned.length === 0 ? <p className="text-sm text-muted-foreground">
      This application owns no record types yet. Add its first record type: its module is created with it.</p> : null}
    {ownedShown.length === 0 ? null : <section aria-label="Owned by this application" className="space-y-2">
      <h3 className="text-xs font-semibold uppercase text-muted-foreground">Owned by this application</h3>
      <ul className="list-none space-y-3">{ownedShown.map((module) => <ModuleNode key={module.key} module={module} owner={undefined}
        selected={selected} expanded={expandedShown} onToggle={toggle} onSelect={choose} disabled={disabled} />)}</ul>
    </section>}
    {used === null && !searching ? <p className="text-sm text-muted-foreground">
      The modules this application uses are listed after the draft is compiled.</p> : null}
    {usedShown.length === 0 ? null : <section aria-label="Used from other applications" className="space-y-2">
      <h3 className="text-xs font-semibold uppercase text-muted-foreground">Used from other applications</h3>
      <ul className="list-none space-y-3">{usedShown.map((module) => <ModuleNode key={module.key} module={module}
        owner={ownerName(module.ownerApplication) ?? "another application"}
        selected={selected} expanded={expandedShown} onToggle={toggle} onSelect={choose} disabled={disabled} />)}</ul>
    </section>}
    {searching && ownedShown.length === 0 && usedShown.length === 0 ? <p className="text-sm text-muted-foreground">Nothing matches.</p> : null}
    <section aria-label="Search" className="space-y-2 border-t border-border pt-3">{search}</section>
  </StudioPanelShell>;
}
