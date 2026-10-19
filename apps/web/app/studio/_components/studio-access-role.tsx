"use client";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { useStudioDraftText } from "./use-studio-draft-text";
import type { ApplicationSourceDocument } from "@vortex/platform/schema";
import { Icon } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import { Alert, AlertDescription } from "@vortex/ui/components/alert";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@vortex/ui/components/dropdown-menu";
import { Popover, PopoverTrigger, PopoverContent } from "@vortex/ui/components/popover";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@vortex/ui/components/sheet";
import { Switch } from "@vortex/ui/components/switch";
import { ToggleGroup, ToggleGroupItem } from "@vortex/ui/components/toggle-group";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import { Input } from "@vortex/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import { Notice } from "@vortex/ui/components/notice";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vortex/ui/components/table";
import {
  studioAccessColumns,
  studioAccessMenuEntries,
  studioAccessPermissions,
  studioAccessRecordRows,
  studioRoleFieldAccess,
  studioRoleHolds,
  StudioReferencePicker,
  type StudioAccessCommand,
  type StudioAccessPermission,
} from "@vortex/ui/studio";
import { StudioField } from "./studio-field";
import { StudioIconButton } from "@vortex/ui/studio";
import { Tooltip, TooltipContent, TooltipTrigger } from "@vortex/ui/components/tooltip";

type Role = ApplicationSourceDocument["body"]["roles"][number];
/** One Access edit; `merge` joins a run of edits to one value (typing a name) into one Undo step. */
export type StudioAccessRun = (command: StudioAccessCommand, merge?: string) => boolean;

function Section({
  title,
  description,
  children,
}: Readonly<{ title: string; description: string; children: ReactNode }>) {
  return (
    <section aria-label={title} className="space-y-2">
      <div>
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

/** One permission as a checkbox: held or not by the role. */
function Grant({
  role,
  permission,
  label,
  disabled,
  run,
}: Readonly<{
  role: Role;
  permission: StudioAccessPermission;
  label: string;
  disabled: boolean;
  run: StudioAccessRun;
}>) {
  return (
    <Checkbox
      aria-label={label}
      title={permission.label}
      checked={studioRoleHolds(role, permission.key) === true}
      disabled={disabled}
      onCheckedChange={(checked) =>
        run({
          kind: "grant",
          roleKey: role.key,
          permissionKey: permission.key,
          granted: checked === true,
        })
      }
    />
  );
}

/** Which fields of one record type the role reads and changes. */
function FieldAccess({
  source,
  role,
  moduleKey,
  recordKey,
  recordName,
  disabled,
  run,
}: Readonly<{
  source: ApplicationSourceDocument;
  role: Role;
  moduleKey: string;
  recordKey: string;
  recordName: string;
  disabled: boolean;
  run: StudioAccessRun;
}>) {
  const [selectedRead, setSelectedRead] = useState<string | undefined>();
  const reads = studioAccessPermissions(source).filter(
    (permission) =>
      permission.moduleKey === moduleKey &&
      permission.recordKey === recordKey &&
      permission.actionKind === "read" &&
      role.permissions.includes(permission.key),
  );
  const access = studioRoleFieldAccess(
    source,
    role.key,
    moduleKey,
    recordKey,
    reads.some((permission) => permission.key === selectedRead) ? selectedRead : undefined,
  );
  const set = (fieldKey: string, readable: boolean, changeable: boolean) =>
    run({
      kind: "set_field_access",
      roleKey: role.key,
      moduleKey,
      recordKey,
      fieldKey,
      readable,
      changeable,
      readPermissionKey: access.kind === "available" ? access.readPermissionKey : "",
    });
  return (
    <div className="space-y-3">
      {reads.length > 1 && (
        <StudioField
          label="Read permission"
          hint="Field edits affect only this Read declaration. Other Read grants keep their own fields."
        >
          {(control) => (
            <StudioReferencePicker
              {...control}
              disabled={disabled}
              value={access.kind === "available" ? access.readPermissionKey : (selectedRead ?? "")}
              options={reads.map((permission) => ({
                value: permission.key,
                label: permission.label,
              }))}
              onChange={setSelectedRead}
            />
          )}
        </StudioField>
      )}
      {access.kind === "unavailable" ? (
        <p className="text-sm text-muted-foreground">{access.message}</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Can see reflects the selected Read permission. Other grants can provide additional
            access. Can change reflects Create and Update.
          </p>
          <Table
            aria-label={`Field access for ${recordName}`}
            containerClassName="border-0"
            className="[&_tr]:h-11 [&_tr>:first-child]:sticky [&_tr>:first-child]:left-0 [&_tr>:first-child]:bg-card [&_tr]:hover:bg-muted/40 [&_th]:text-xs [&_th]:text-foreground [&_th]:normal-case [&_th]:tracking-normal [&_th]:font-medium"
          >
            <TableHeader>
              <TableRow>
                <TableHead>Field</TableHead>
                <TableHead className="w-20 text-center">Can see</TableHead>
                <TableHead className="w-20 text-center">Can change</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {access.fields.map((field) => (
                <TableRow key={field.key}>
                  <TableCell>
                    {field.label}
                    {field.producedByPlatform && (
                      <span className="block text-sm text-muted-foreground">
                        Filled by the platform
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    <Checkbox
                      aria-label={`${role.name} can see ${field.label} on ${recordName}`}
                      checked={field.readable}
                      disabled={disabled}
                      onCheckedChange={(checked) => set(field.key, checked === true, false)}
                    />
                  </TableCell>
                  <TableCell className="text-center">
                    <Checkbox
                      aria-label={`${role.name} can change ${field.label} on ${recordName}`}
                      checked={field.changeable}
                      disabled={disabled || field.producedByPlatform || !access.canChange}
                      onCheckedChange={(checked) =>
                        set(field.key, field.readable || checked === true, checked === true)
                      }
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </div>
  );
}

/**
 * One role of the application: its name, where its people start, and what it holds, as a matrix of
 * record types by action, the pages it opens, its actions, and per record type which fields it can
 * see and change. Each tick is one edit of the draft.
 */
export function StudioAccessRoleEditor({
  source,
  role,
  compiledGrants,
  disabled,
  run,
  onPreview,
}: Readonly<{
  source: ApplicationSourceDocument;
  role: Role;
  /** The permissions the compiled saved draft grants this role, to list a role that holds every permission. */
  compiledGrants: readonly string[] | undefined;
  disabled: boolean;
  run: StudioAccessRun;
  onPreview: () => void;
}>) {
  const [confirm, confirmDialog] = useConfirm();
  const name = useStudioDraftText(role.name, (next) =>
    next.trim().length === 0
      ? "Enter a name for the role."
      : run({ kind: "rename_role", roleKey: role.key, name: next }, `role-name:${role.key}`) || "",
  );
  const [editingName, setEditingName] = useState(false);
  const [fieldsOf, setFieldsOf] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(() => studioAccessRecordRows(source), [source]);
  const permissions = useMemo(() => studioAccessPermissions(source), [source]);
  const gates = new Set(source.body.pages.map((page) => page.permission));
  const actions = permissions.filter(
    (permission) => permission.moduleKey === undefined && !gates.has(permission.key),
  );
  const declared = new Set(permissions.map((permission) => permission.key));
  const elsewhere = role.permissions.filter((key) => key !== "*" && !declared.has(key));
  const labelOf = (key: string) =>
    permissions.find((permission) => permission.key === key)?.label ?? key;
  const wildcard = role.permissions.includes("*");
  const menuEntries = studioAccessMenuEntries(source);
  const fieldRow = rows.find((row) => `${row.moduleKey}:${row.recordKey}` === fieldsOf);

  const remove = async () => {
    if (
      !(await confirm({
        title: `Remove the role “${role.name}”?`,
        description:
          "The role leaves the draft. After the next upgrade, people who hold it lose what it gives them. Undo brings it back.",
        confirmLabel: "Remove role",
        destructive: true,
      }))
    )
      return;
    run({ kind: "remove_role", roleKey: role.key });
  };

  return (
    <section aria-label={`Role ${role.name}`} className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        {editingName ? (
          <div
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget) && name.problem === "")
                setEditingName(false);
            }}
          >
            <StudioField
              label="Role name"
              error={name.problem === "" ? undefined : name.problem}
              onUndo={name.reset}
            >
              {(control) => (
                <Input
                  {...control}
                  autoFocus
                  value={name.text}
                  maxLength={60}
                  disabled={disabled}
                  onChange={(event) => name.change(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && name.problem === "") setEditingName(false);
                  }}
                />
              )}
            </StudioField>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-xl font-semibold tracking-tight">{role.name}</h2>
            <StudioIconButton
              label={`Rename ${role.name}`}
              disabled={disabled}
              onClick={() => setEditingName(true)}
            >
              <Icon name="sliders-horizontal" />
            </StudioIconButton>
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onPreview}>
            <Icon name="eye" />
            Preview as {role.name}
          </Button>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <DropdownMenuTrigger
                    render={
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`More actions for ${role.name}`}
                      />
                    }
                  />
                }
              >
                <Icon name="more-horizontal" />
              </TooltipTrigger>
              <TooltipContent>More actions for {role.name}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={disabled || role.default_member === true}
                onClick={() => run({ kind: "set_default_member", roleKey: role.key })}
              >
                <Icon name="users" />
                Make default
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={disabled}
                onClick={() => {
                  void remove();
                }}
              >
                <Icon name="close" />
                Remove role
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {role.default_member === true && (
        <Alert variant="info" className="border-0 bg-transparent">
          <Icon name="info" />
          <AlertDescription>
            Default member role: offered to the person who first installs the application.
          </AlertDescription>
        </Alert>
      )}
      <div className="max-w-sm">
        <StudioField label="Starts on" hint="The page its people see first.">
          {(control) => (
            <NativeSelect
              {...control}
              value={role.home_page}
              disabled={disabled}
              onChange={(event) =>
                run({ kind: "set_role_home_page", roleKey: role.key, pageKey: event.target.value })
              }
            >
              {source.body.pages
                .filter((page) => page.type !== "detail" && page.type !== "public")
                .map((page) => (
                  <NativeSelectOption key={page.key} value={page.key}>
                    {page.name}
                  </NativeSelectOption>
                ))}
            </NativeSelect>
          )}
        </StudioField>
      </div>

      {wildcard ? (
        <div className="space-y-2">
          <Notice
            severity="info"
            content={`${role.name} holds every permission of the application that is not administrative. To choose them one by one, list them first.`}
          />
          <Button
            type="button"
            size="sm"
            disabled={disabled || compiledGrants === undefined}
            onClick={() =>
              run({
                kind: "list_role_permissions",
                roleKey: role.key,
                permissionKeys: compiledGrants ?? [],
              })
            }
          >
            List its permissions one by one
          </Button>
          {compiledGrants === undefined && (
            <p className="text-sm text-muted-foreground">
              They are listed once your latest change is saved.
            </p>
          )}
        </div>
      ) : (
        <>
          <Section
            title="Records"
            description="Choose record permissions, then Fields for what this role can see and change."
          >
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This application has no record types yet. Add them in Data.
              </p>
            ) : (
              <div className="overflow-hidden rounded-xl border">
                <Table
                  aria-label="Record access"
                  containerClassName="border-0"
                  className="[&_tr]:h-11 [&_tr>:first-child]:sticky [&_tr>:first-child]:left-0 [&_tr>:first-child]:bg-card [&_tr]:hover:bg-muted/40 [&_th]:bg-muted/50 [&_th]:text-xs [&_th]:normal-case [&_th]:tracking-normal [&_th]:font-medium [&_th]:text-foreground"
                >
                  <TableHeader>
                    <TableRow>
                      <TableHead className="sticky left-0 z-10 bg-background">
                        Record type
                      </TableHead>
                      {studioAccessColumns.map((column) => (
                        <TableHead key={column.kind} className="w-20 text-center">
                          {column.label}
                        </TableHead>
                      ))}
                      <TableHead>Fields</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => {
                      const id = `${row.moduleKey}:${row.recordKey}`;
                      return (
                        <Fragment key={id}>
                          <TableRow>
                            <TableCell className="sticky left-0 bg-background font-medium">
                              {row.more.length === 0 ? (
                                row.name
                              ) : (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="xs"
                                  className="justify-start text-sm font-medium"
                                  aria-expanded={expanded.has(id)}
                                  aria-controls={`extra-${row.moduleKey}-${row.recordKey}`}
                                  aria-label={`Extra permissions for ${row.name}`}
                                  onClick={() =>
                                    setExpanded((current) => {
                                      const next = new Set(current);
                                      if (next.has(id)) next.delete(id);
                                      else next.add(id);
                                      return next;
                                    })
                                  }
                                >
                                  <Icon
                                    name={expanded.has(id) ? "chevron-down" : "chevron-right"}
                                    className="size-4"
                                  />
                                  {row.name}
                                </Button>
                              )}
                            </TableCell>
                            {studioAccessColumns.map((column) => (
                              <TableCell key={column.kind} className="text-center">
                                {row.columns[column.kind].length === 0 ? (
                                  <span
                                    className="text-muted-foreground"
                                    title="No such permission"
                                  >
                                    –
                                  </span>
                                ) : row.columns[column.kind].length === 1 ? (
                                  <Grant
                                    role={role}
                                    permission={row.columns[column.kind][0]!}
                                    disabled={disabled}
                                    run={run}
                                    label={`${role.name} can ${column.kind} ${row.name}`}
                                  />
                                ) : (
                                  <Popover>
                                    <PopoverTrigger
                                      render={
                                        <Button
                                          type="button"
                                          size="xs"
                                          className="text-sm"
                                          variant="ghost"
                                          aria-label={`${role.name} can ${column.kind} ${row.name}: choose permissions`}
                                        />
                                      }
                                    >
                                      {
                                        row.columns[column.kind].filter((permission) =>
                                          studioRoleHolds(role, permission.key),
                                        ).length
                                      }
                                      /{row.columns[column.kind].length}
                                      <Icon name="chevron-down" />
                                    </PopoverTrigger>
                                    <PopoverContent>
                                      <ToggleGroup
                                        multiple
                                        aria-label={`${role.name} can ${column.kind} ${row.name}`}
                                        orientation="vertical"
                                        className="w-full items-stretch"
                                        disabled={disabled}
                                        value={row.columns[column.kind]
                                          .filter((permission) =>
                                            studioRoleHolds(role, permission.key),
                                          )
                                          .map((permission) => permission.key)}
                                        onValueChange={(next) => {
                                          for (const permission of row.columns[column.kind]) {
                                            const granted = next.includes(permission.key);
                                            if (granted !== studioRoleHolds(role, permission.key))
                                              run({
                                                kind: "grant",
                                                roleKey: role.key,
                                                permissionKey: permission.key,
                                                granted,
                                              });
                                          }
                                        }}
                                      >
                                        {row.columns[column.kind].map((permission) => (
                                          <ToggleGroupItem
                                            key={permission.key}
                                            value={permission.key}
                                            aria-label={`${role.name}: ${permission.label}`}
                                          >
                                            {permission.label}
                                          </ToggleGroupItem>
                                        ))}
                                      </ToggleGroup>
                                    </PopoverContent>
                                  </Popover>
                                )}
                              </TableCell>
                            ))}
                            <TableCell>
                              <StudioIconButton
                                label={`Fields of ${row.name}`}
                                onClick={() => setFieldsOf(id)}
                              >
                                <Icon name="sliders-horizontal" />
                              </StudioIconButton>
                            </TableCell>
                          </TableRow>
                          {expanded.has(id) && (
                            <TableRow id={`extra-${row.moduleKey}-${row.recordKey}`}>
                              <TableCell colSpan={studioAccessColumns.length + 2}>
                                <div className="flex flex-wrap gap-3 text-sm">
                                  {row.more.map((permission) => (
                                    <label key={permission.key} className="flex items-center gap-1">
                                      <Grant
                                        role={role}
                                        permission={permission}
                                        label={`${role.name}: ${permission.label} on ${row.name}`}
                                        disabled={disabled}
                                        run={run}
                                      />
                                      {permission.label}
                                    </label>
                                  ))}
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </Section>

          <Section title="Pages" description="Pages with the same permission open together.">
            <div className="overflow-hidden rounded-xl border">
              <Table
                aria-label="Page access"
                containerClassName="border-0"
                className="[&_tr]:h-11 [&_tr>:first-child]:sticky [&_tr>:first-child]:left-0 [&_tr>:first-child]:bg-card [&_tr]:hover:bg-muted/40 [&_th]:bg-muted/50 [&_th]:text-xs [&_th]:normal-case [&_th]:tracking-normal [&_th]:font-medium [&_th]:text-foreground"
              >
                <TableHeader>
                  <TableRow>
                    <TableHead>Page</TableHead>
                    <TableHead>Opens with</TableHead>
                    <TableHead className="w-20 text-center">Can open</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {source.body.pages.map((page) => {
                    const permission = permissions.find((entry) => entry.key === page.permission);
                    return (
                      <TableRow key={page.id}>
                        <TableCell className="font-medium">{page.name}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {labelOf(page.permission)}
                        </TableCell>
                        <TableCell className="text-center">
                          {permission === undefined ? (
                            "–"
                          ) : (
                            <Switch
                              aria-label={`${role.name} can open ${page.name}`}
                              checked={studioRoleHolds(role, permission.key) === true}
                              disabled={disabled}
                              onCheckedChange={(granted) =>
                                run({
                                  kind: "grant",
                                  roleKey: role.key,
                                  permissionKey: permission.key,
                                  granted,
                                })
                              }
                            />
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </Section>

          {menuEntries.length > 0 && (
            <Section title="Menu" description="Which menu entries this role can see.">
              <div className="overflow-hidden rounded-xl border">
                <Table
                  aria-label="Menu access"
                  containerClassName="border-0"
                  className="[&_tr]:h-11 [&_tr>:first-child]:sticky [&_tr>:first-child]:left-0 [&_tr>:first-child]:bg-card [&_tr]:hover:bg-muted/40 [&_th]:normal-case [&_th]:tracking-normal [&_th]:text-foreground"
                >
                  <TableHeader>
                    <TableRow>
                      <TableHead>Menu entry</TableHead>
                      <TableHead>Shows with</TableHead>
                      <TableHead className="w-20 text-center">Can see</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {menuEntries.map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell className="font-medium">{entry.label}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {labelOf(entry.permission)}
                        </TableCell>
                        <TableCell className="text-center">
                          <Switch
                            aria-label={`${role.name} can see the menu entry ${entry.label}`}
                            checked={studioRoleHolds(role, entry.permission) === true}
                            disabled={disabled}
                            onCheckedChange={(granted) =>
                              run({
                                kind: "grant",
                                roleKey: role.key,
                                permissionKey: entry.permission,
                                granted,
                              })
                            }
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Section>
          )}

          {actions.length > 0 && (
            <Section
              title="Actions"
              description="The application's other permissions, such as buttons and steps that need one."
            >
              <div className="overflow-hidden rounded-xl border">
                <Table
                  aria-label="Action access"
                  containerClassName="border-0"
                  className="[&_tr]:h-11 [&_tr>:first-child]:sticky [&_tr>:first-child]:left-0 [&_tr>:first-child]:bg-card [&_tr]:hover:bg-muted/40 [&_th]:bg-muted/50 [&_th]:text-xs [&_th]:normal-case [&_th]:tracking-normal [&_th]:font-medium [&_th]:text-foreground"
                >
                  <TableHeader>
                    <TableRow>
                      <TableHead>Permission</TableHead>
                      <TableHead className="w-20 text-center">Can use</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {actions.map((permission) => (
                      <TableRow key={permission.key}>
                        <TableCell>
                          <span className="font-medium">{permission.label}</span>
                          <span className="block text-sm text-muted-foreground">
                            {permission.description}
                          </span>
                        </TableCell>
                        <TableCell className="text-center">
                          <Grant
                            role={role}
                            permission={permission}
                            label={`${role.name} can use ${permission.label}`}
                            disabled={disabled}
                            run={run}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Section>
          )}

          {elsewhere.length > 0 && (
            <Section
              title="From other applications and the platform"
              description="Permissions this role holds that another application or the platform declares."
            >
              <ul className="space-y-1">
                {elsewhere.map((key) => (
                  <li key={key} className="flex items-center justify-between gap-2 text-sm">
                    <code className="break-all">{key}</code>
                    <StudioIconButton
                      label={`Remove ${key} from ${role.name}`}
                      destructive
                      disabled={disabled}
                      onClick={() =>
                        run({
                          kind: "grant",
                          roleKey: role.key,
                          permissionKey: key,
                          granted: false,
                        })
                      }
                    >
                      <Icon name="close" />
                    </StudioIconButton>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </>
      )}
      <Sheet
        open={fieldRow !== undefined}
        onOpenChange={(open) => {
          if (!open) setFieldsOf(null);
        }}
      >
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Fields of {fieldRow?.name}</SheetTitle>
            <SheetDescription>What {role.name} can see and change.</SheetDescription>
          </SheetHeader>
          {fieldRow !== undefined && (
            <div className="px-4">
              <div className="overflow-hidden rounded-xl border">
                <FieldAccess
                  source={source}
                  role={role}
                  moduleKey={fieldRow.moduleKey}
                  recordKey={fieldRow.recordKey}
                  recordName={fieldRow.name}
                  disabled={disabled}
                  run={run}
                />
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
      {confirmDialog}
    </section>
  );
}
