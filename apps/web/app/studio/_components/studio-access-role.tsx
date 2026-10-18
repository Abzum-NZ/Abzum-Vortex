"use client";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { useStudioDraftText } from "./use-studio-draft-text";
import type { ApplicationSourceDocument } from "@vortex/platform/schema";
import { Icon } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import { Input } from "@vortex/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import { Notice } from "@vortex/ui/components/notice";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@vortex/ui/components/table";
import {
  studioAccessColumns, studioAccessPermissions, studioAccessRecordRows, studioRoleFieldAccess, studioRoleHolds,
  type StudioAccessCommand, type StudioAccessPermission,
} from "@vortex/ui/studio";
import { StudioField } from "./studio-field";

type Role = ApplicationSourceDocument["body"]["roles"][number];
/** One Access edit; `merge` joins a run of edits to one value (typing a name) into one Undo step. */
export type StudioAccessRun = (command: StudioAccessCommand, merge?: string) => boolean;

function Section({ title, description, children }: Readonly<{ title: string; description: string; children: ReactNode }>) {
  return <section aria-label={title} className="space-y-2">
    <div>
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
    {children}
  </section>;
}

/** One permission as a checkbox: held or not by the role. */
function Grant({ role, permission, label, disabled, run }: Readonly<{
  role: Role; permission: StudioAccessPermission; label: string; disabled: boolean; run: StudioAccessRun;
}>) {
  return <Checkbox aria-label={label} title={permission.label} checked={studioRoleHolds(role, permission.key) === true}
    disabled={disabled}
    onCheckedChange={(checked) => run({ kind: "grant", roleKey: role.key, permissionKey: permission.key, granted: checked === true })} />;
}

/** Which fields of one record type the role reads and changes. */
function FieldAccess({ source, role, moduleKey, recordKey, disabled, run }: Readonly<{
  source: ApplicationSourceDocument; role: Role; moduleKey: string; recordKey: string; disabled: boolean; run: StudioAccessRun;
}>) {
  const access = studioRoleFieldAccess(source, role.key, moduleKey, recordKey);
  if (access.kind === "unavailable") return <p className="text-sm text-muted-foreground">{access.message}</p>;
  const set = (fieldKey: string, readable: boolean, changeable: boolean) =>
    run({ kind: "set_field_access", roleKey: role.key, moduleKey, recordKey, fieldKey, readable, changeable });
  return <Table aria-label="Field access">
    <TableHeader><TableRow>
      <TableHead>Field</TableHead><TableHead className="text-center">Can see</TableHead><TableHead className="text-center">Can change</TableHead>
    </TableRow></TableHeader>
    <TableBody>{access.fields.map((field) => <TableRow key={field.key}>
      <TableCell>{field.label}{field.producedByPlatform &&
        <span className="block text-xs text-muted-foreground">Filled by the platform</span>}</TableCell>
      <TableCell className="text-center"><Checkbox aria-label={`${role.name} can see ${field.label}`} checked={field.readable}
        disabled={disabled} onCheckedChange={(checked) => set(field.key, checked === true, false)} /></TableCell>
      <TableCell className="text-center"><Checkbox aria-label={`${role.name} can change ${field.label}`} checked={field.changeable}
        disabled={disabled || field.producedByPlatform || !access.canChange}
        onCheckedChange={(checked) => set(field.key, field.readable || checked === true, checked === true)} /></TableCell>
    </TableRow>)}</TableBody>
  </Table>;
}

/**
 * One role of the application: its name, where its people start, and what it holds, as a matrix of
 * record types by action, the pages it opens, its actions, and per record type which fields it can
 * see and change. Each tick is one edit of the draft.
 */
export function StudioAccessRoleEditor({ source, role, compiledGrants, disabled, run, onPreview }: Readonly<{
  source: ApplicationSourceDocument;
  role: Role;
  /** The permissions the compiled saved draft grants this role, to list a role that holds every permission. */
  compiledGrants: readonly string[] | undefined;
  disabled: boolean;
  run: StudioAccessRun;
  onPreview: () => void;
}>) {
  const [confirm, confirmDialog] = useConfirm();
  const name = useStudioDraftText(role.name, (next) => next.trim().length === 0 ? "Enter a name for the role."
    : run({ kind: "rename_role", roleKey: role.key, name: next }, `role-name:${role.key}`) || "");
  const [fieldsOf, setFieldsOf] = useState<string | null>(null);
  const rows = useMemo(() => studioAccessRecordRows(source), [source]);
  const permissions = useMemo(() => studioAccessPermissions(source), [source]);
  const gates = new Set(source.body.pages.map((page) => page.permission));
  const actions = permissions.filter((permission) => permission.moduleKey === undefined && !gates.has(permission.key));
  const declared = new Set(permissions.map((permission) => permission.key));
  const elsewhere = role.permissions.filter((key) => key !== "*" && !declared.has(key));
  const labelOf = (key: string) => permissions.find((permission) => permission.key === key)?.label ?? key;
  const wildcard = role.permissions.includes("*");

  const remove = async () => {
    if (!await confirm({
      title: `Remove the role “${role.name}”?`,
      description: "The role leaves the draft. After the next upgrade, people who hold it lose what it gives them. Undo brings it back.",
      confirmLabel: "Remove role",
    })) return;
    run({ kind: "remove_role", roleKey: role.key });
  };

  return <section aria-label={`Role ${role.name}`} className="space-y-6">
    <div className="flex flex-wrap items-end gap-3">
      <StudioField label="Role name" error={name.problem === "" ? undefined : name.problem}>
        {(control) => <Input {...control} value={name.text} maxLength={60} disabled={disabled} onChange={(event) => name.change(event.target.value)} />}
      </StudioField>
      <StudioField label="Starts on" hint="The page its people see first.">
        {(control) => <NativeSelect {...control} value={role.home_page} disabled={disabled}
          onChange={(event) => run({ kind: "set_role_home_page", roleKey: role.key, pageKey: event.target.value })}>
          {source.body.pages.filter((page) => page.type !== "detail" && page.type !== "public").map((page) =>
            <NativeSelectOption key={page.key} value={page.key}>{page.name}</NativeSelectOption>)}
        </NativeSelect>}
      </StudioField>
      <Button type="button" size="sm" variant="outline" onClick={onPreview}><Icon name="eye" />Preview as {role.name}</Button>
      <Button type="button" size="sm" variant="destructive" disabled={disabled} onClick={() => { void remove(); }}>Remove role</Button>
    </div>
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3">
      {role.default_member === true
        ? <p className="text-sm"><span className="font-medium">Default member role.</span> A first install offers this role to the person who installs the application.</p>
        : <>
          <p className="text-sm text-muted-foreground">A first install offers the default member role to the person who installs the application. The application has exactly one.</p>
          <Button type="button" size="sm" variant="outline" disabled={disabled}
            onClick={() => run({ kind: "set_default_member", roleKey: role.key })}>Make this the default member role</Button>
        </>}
    </div>

    {wildcard ? <div className="space-y-2">
      <Notice severity="info" content={`${role.name} holds every permission of the application that is not administrative. To choose them one by one, list them first.`} />
      <Button type="button" size="sm" disabled={disabled || compiledGrants === undefined}
        onClick={() => run({ kind: "list_role_permissions", roleKey: role.key, permissionKeys: compiledGrants ?? [] })}>
        List its permissions one by one</Button>
      {compiledGrants === undefined && <p className="text-sm text-muted-foreground">They are listed once your latest change is saved.</p>}
    </div> : <>
      <Section title="Records" description="What people with this role can do with each record type. Choose Fields for which fields they can see and change.">
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">This application has no record types yet. Add them in Data.</p>
          : <Table aria-label="Record access">
            <TableHeader><TableRow>
              <TableHead>Record type</TableHead>
              {studioAccessColumns.map((column) => <TableHead key={column.kind} className="text-center">{column.label}</TableHead>)}
              <TableHead>Fields</TableHead>
            </TableRow></TableHeader>
            <TableBody>{rows.map((row) => {
              const id = `${row.moduleKey}:${row.recordKey}`;
              return <Fragment key={id}>
                <TableRow>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  {studioAccessColumns.map((column) => <TableCell key={column.kind} className="text-center">
                    {row.columns[column.kind].length === 0 ? <span className="text-muted-foreground" title="No such permission">–</span>
                      : <div className="flex flex-col items-center gap-1">{row.columns[column.kind].map((permission) =>
                        <label key={permission.key} className="flex items-center gap-1 text-xs">
                          <Grant role={role} permission={permission} disabled={disabled} run={run}
                            label={`${column.label} ${row.name}${row.columns[column.kind].length > 1 ? `: ${permission.label}` : ""}`} />
                          {row.columns[column.kind].length > 1 && permission.label}
                        </label>)}</div>}
                  </TableCell>)}
                  <TableCell>
                    <Button type="button" size="sm" variant={fieldsOf === id ? "secondary" : "ghost"} aria-expanded={fieldsOf === id}
                      onClick={() => setFieldsOf(fieldsOf === id ? null : id)}>Fields</Button>
                  </TableCell>
                </TableRow>
                {row.more.length > 0 && <TableRow>
                  <TableCell colSpan={studioAccessColumns.length + 2}>
                    <div className="flex flex-wrap gap-3 text-sm">
                      <span className="text-muted-foreground">Also:</span>
                      {row.more.map((permission) => <label key={permission.key} className="flex items-center gap-1">
                        <Grant role={role} permission={permission} label={permission.label} disabled={disabled} run={run} />
                        {permission.label}</label>)}
                    </div>
                  </TableCell>
                </TableRow>}
                {fieldsOf === id && <TableRow>
                  <TableCell colSpan={studioAccessColumns.length + 2}>
                    <FieldAccess source={source} role={role} moduleKey={row.moduleKey} recordKey={row.recordKey} disabled={disabled} run={run} />
                  </TableCell>
                </TableRow>}
              </Fragment>;
            })}</TableBody>
          </Table>}
      </Section>

      <Section title="Pages" description="The pages people with this role can open. A page opens with one permission; pages that share it open together.">
        <Table aria-label="Page access">
          <TableHeader><TableRow><TableHead>Page</TableHead><TableHead>Opens with</TableHead><TableHead className="text-center">Can open</TableHead></TableRow></TableHeader>
          <TableBody>{source.body.pages.map((page) => {
            const permission = permissions.find((entry) => entry.key === page.permission);
            return <TableRow key={page.id}>
              <TableCell className="font-medium">{page.name}</TableCell>
              <TableCell className="text-muted-foreground">{labelOf(page.permission)}</TableCell>
              <TableCell className="text-center">{permission === undefined ? "–"
                : <Grant role={role} permission={permission} label={`${role.name} can open ${page.name}`} disabled={disabled} run={run} />}</TableCell>
            </TableRow>;
          })}</TableBody>
        </Table>
      </Section>

      {actions.length > 0 && <Section title="Actions" description="The application's other permissions, such as buttons and steps that need one.">
        <Table aria-label="Action access">
          <TableHeader><TableRow><TableHead>Permission</TableHead><TableHead className="text-center">Can use</TableHead></TableRow></TableHeader>
          <TableBody>{actions.map((permission) => <TableRow key={permission.key}>
            <TableCell><span className="font-medium">{permission.label}</span>
              <span className="block text-xs text-muted-foreground">{permission.description}</span></TableCell>
            <TableCell className="text-center"><Grant role={role} permission={permission} label={`${role.name} can use ${permission.label}`}
              disabled={disabled} run={run} /></TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </Section>}

      {elsewhere.length > 0 && <Section title="From other applications and the platform"
        description="Permissions this role holds that another application or the platform declares.">
        <ul className="space-y-1">{elsewhere.map((key) => <li key={key} className="flex items-center justify-between gap-2 text-sm">
          <code className="break-all">{key}</code>
          <Button type="button" size="sm" variant="ghost" disabled={disabled}
            onClick={() => run({ kind: "grant", roleKey: role.key, permissionKey: key, granted: false })}>Remove</Button>
        </li>)}</ul>
      </Section>}
    </>}
    {confirmDialog}
  </section>;
}
