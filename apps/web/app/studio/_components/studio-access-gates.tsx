"use client";
import { useMemo, useState, type FormEvent } from "react";
import type { ApplicationSourceDocument } from "@vortex/platform/schema";
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@vortex/ui/components/table";
import {
  studioAccessGateChoices, studioAccessMenuEntries, studioAccessPermissions,
  type StudioAccessGate,
} from "@vortex/ui/studio";
import type { StudioAccessRun } from "./studio-access-role";
import { StudioField } from "./studio-field";

const newChoice = "__new__";

/** Chooses the permission that opens a page or shows a menu entry, or names a new one. */
function GateSelect({ source, value, label, disabled, onGate }: Readonly<{
  source: ApplicationSourceDocument; value: string; label: string; disabled: boolean;
  onGate: (gate: StudioAccessGate) => boolean;
}>) {
  const choices = useMemo(() => studioAccessGateChoices(source), [source]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const known = choices.some((choice) => choice.key === value);
  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (onGate({ kind: "new", label: name })) { setCreating(false); setName(""); }
  };
  return <div className="space-y-2">
    <NativeSelect size="sm" aria-label={label} value={creating ? newChoice : value} disabled={disabled}
      onChange={(event) => {
        if (event.target.value === newChoice) { setCreating(true); return; }
        setCreating(false);
        onGate({ kind: "existing", key: event.target.value });
      }}>
      {known ? null : <NativeSelectOption value={value}>Undeclared permission</NativeSelectOption>}
      {choices.map((choice) => <NativeSelectOption key={choice.key} value={choice.key}>
        {choice.label}{choice.roles.length === 0 ? " (no role yet)" : ` (${choice.roles.join(", ")})`}</NativeSelectOption>)}
      <NativeSelectOption value={newChoice}>New permission…</NativeSelectOption>
    </NativeSelect>
    {creating && <form className="flex items-end gap-2" onSubmit={create}>
      <StudioField label="New permission">
        {(control) => <Input {...control} value={name} maxLength={60} placeholder="For example: View reports" autoFocus
          disabled={disabled} onChange={(event) => setName(event.target.value)} />}
      </StudioField>
      <Button type="submit" size="sm" disabled={disabled || name.trim().length === 0}>Add and use</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
    </form>}
  </div>;
}

/**
 * Who opens each page and sees each menu entry: one permission each, chosen from the application's
 * own named permissions. A page's menu entries follow the page when it changes, so they stay alike.
 */
export function StudioAccessPageGates({ source, disabled, run }: Readonly<{
  source: ApplicationSourceDocument; disabled: boolean; run: StudioAccessRun;
}>) {
  const entries = useMemo(() => studioAccessMenuEntries(source), [source]);
  const external = entries.filter((entry) => entry.type === "external");
  return <section aria-label="Pages and menu" className="space-y-4">
    <p className="text-sm text-muted-foreground">A page opens for people who hold its permission, and a menu entry shows for people who hold its own. Give the permission to roles in each role&apos;s page.</p>
    <Table aria-label="Who opens each page">
      <TableHeader><TableRow><TableHead>Page</TableHead><TableHead>Opens for people who hold</TableHead><TableHead>Its menu entries show for</TableHead></TableRow></TableHeader>
      <TableBody>{source.body.pages.map((page) => {
        const own = entries.filter((entry) => entry.type === "page" && entry.page === page.key);
        return <TableRow key={page.id}>
          <TableCell className="align-top font-medium">{page.name}</TableCell>
          <TableCell className="align-top">
            <GateSelect source={source} value={page.permission} label={`Who can open ${page.name}`} disabled={disabled}
              onGate={(gate) => run({ kind: "set_page_gate", pageAlias: page.id, gate })} />
          </TableCell>
          <TableCell className="align-top">{own.length === 0 ? <span className="text-sm text-muted-foreground">Not in the menu</span>
            : <div className="space-y-2">{own.map((entry) => <div key={entry.id} className="space-y-1">
              <p className="text-xs text-muted-foreground">{entry.label}</p>
              <GateSelect source={source} value={entry.permission} label={`Who sees the menu entry ${entry.label}`} disabled={disabled}
                onGate={(gate) => run({ kind: "set_menu_gate", alias: entry.id, gate })} />
            </div>)}</div>}</TableCell>
        </TableRow>;
      })}</TableBody>
    </Table>
    {external.length > 0 && <Table aria-label="Who sees each link">
      <TableHeader><TableRow><TableHead>Menu link</TableHead><TableHead>Shows for people who hold</TableHead></TableRow></TableHeader>
      <TableBody>{external.map((entry) => <TableRow key={entry.id}>
        <TableCell className="font-medium">{entry.label}</TableCell>
        <TableCell><GateSelect source={source} value={entry.permission} label={`Who sees the link ${entry.label}`} disabled={disabled}
          onGate={(gate) => run({ kind: "set_menu_gate", alias: entry.id, gate })} /></TableCell>
      </TableRow>)}</TableBody>
    </Table>}
  </section>;
}

/** Every permission the draft declares, who holds it, and adding or removing one. */
export function StudioAccessPermissionList({ source, disabled, run }: Readonly<{
  source: ApplicationSourceDocument; disabled: boolean; run: StudioAccessRun;
}>) {
  const [name, setName] = useState("");
  const permissions = useMemo(() => studioAccessPermissions(source), [source]);
  const owner = (moduleKey: string | undefined, recordKey: string | undefined) => {
    if (moduleKey === undefined) return "This application";
    const module = source.body.modules.find((entry) => entry.key === moduleKey);
    const record = module?.record_types.find((entry) => entry.key === recordKey);
    return record === undefined ? module?.name ?? moduleKey : `${record.plural_name} (${module!.name})`;
  };
  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (run({ kind: "add_permission", label: name })) setName("");
  };
  return <section aria-label="Permissions" className="space-y-4">
    <form className="flex items-end gap-2" onSubmit={add}>
      <StudioField label="New permission" hint="A permission of this application that can open pages and show menu entries.">
        {(control) => <Input {...control} value={name} maxLength={60} placeholder="For example: View reports" disabled={disabled}
          onChange={(event) => setName(event.target.value)} />}
      </StudioField>
      <Button type="submit" size="sm" disabled={disabled || name.trim().length === 0}>Add permission</Button>
    </form>
    <Table aria-label="Permissions of the application">
      <TableHeader><TableRow><TableHead>Permission</TableHead><TableHead>Belongs to</TableHead><TableHead>Held by</TableHead><TableHead /></TableRow></TableHeader>
      <TableBody>{permissions.map((permission) => {
        const roles = source.body.roles.filter((role) => role.permissions.includes(permission.key)).map((role) => role.name);
        return <TableRow key={permission.key}>
          <TableCell><span className="font-medium">{permission.label}</span>
            <span className="block text-xs text-muted-foreground">{permission.description}</span></TableCell>
          <TableCell className="text-sm">{owner(permission.moduleKey, permission.recordKey)}</TableCell>
          <TableCell className="text-sm">{roles.length === 0 ? <span className="text-muted-foreground">No role</span> : roles.join(", ")}</TableCell>
          <TableCell className="text-right">{permission.standard
            ? <span className="text-xs text-muted-foreground">Comes with its record type</span>
            : <Button type="button" size="sm" variant="ghost" disabled={disabled}
              onClick={() => run({ kind: "remove_permission", permissionKey: permission.key })}>Remove</Button>}</TableCell>
        </TableRow>;
      })}</TableBody>
    </Table>
  </section>;
}
