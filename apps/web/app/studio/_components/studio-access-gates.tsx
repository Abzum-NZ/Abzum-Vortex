"use client";
import { Fragment, useMemo, useState, type FormEvent } from "react";
import { applicationUses, type ApplicationSourceDocument } from "@vortex/platform/schema";
import { Icon } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";
import { Badge } from "@vortex/ui/components/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vortex/ui/components/table";
import {
  studioAccessGateChoices,
  studioAccessMenuEntries,
  studioAccessPermissions,
  StudioIconButton,
  StudioReferencePicker,
  type StudioAccessGate,
} from "@vortex/ui/studio";
import { StudioPermissionDeclaration } from "./studio-permission-declaration";
import type { StudioAccessRun } from "./studio-access-role";
import { StudioField } from "./studio-field";
import { StudioPlaceList } from "./studio-used-in";
import { Tooltip, TooltipContent, TooltipTrigger } from "@vortex/ui/components/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@vortex/ui/components/popover";

const newChoice = "__new__";

/** Chooses the permission that opens a page or shows a menu entry, or names a new one. */
function GateSelect({
  source,
  value,
  label,
  disabled,
  onGate,
}: Readonly<{
  source: ApplicationSourceDocument;
  value: string;
  label: string;
  disabled: boolean;
  onGate: (gate: StudioAccessGate) => boolean;
}>) {
  const choices = useMemo(() => studioAccessGateChoices(source), [source]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (onGate({ kind: "new", label: name })) {
      setCreating(false);
      setName("");
    }
  };
  return (
    <div className="space-y-2">
      <StudioReferencePicker
        aria-label={label}
        value={creating ? newChoice : value}
        disabled={disabled}
        options={[
          ...choices.map((choice) => ({
            value: choice.key,
            label: choice.label,
            description: choice.roles.length === 0 ? "No role yet" : choice.roles.join(", "),
          })),
          { value: newChoice, label: "New permission" },
        ]}
        onChange={(key) => {
          setCreating(key === newChoice);
          if (key !== newChoice) onGate({ kind: "existing", key });
        }}
      />
      {creating && (
        <form className="flex items-end gap-2" onSubmit={create}>
          <StudioField label="New permission">
            {(control) => (
              <Input
                {...control}
                value={name}
                maxLength={60}
                placeholder="For example: View reports"
                autoFocus
                disabled={disabled}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </StudioField>
          <Button type="submit" size="sm" disabled={disabled || name.trim().length === 0}>
            Add and use
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setCreating(false)}>
            Cancel
          </Button>
        </form>
      )}
    </div>
  );
}

/**
 * Who opens each page and sees each menu entry: one permission each, chosen from the application's
 * own named permissions. A page's menu entries follow the page when it changes, so they stay alike.
 */
export function StudioAccessPageGates({
  source,
  disabled,
  run,
}: Readonly<{
  source: ApplicationSourceDocument;
  disabled: boolean;
  run: StudioAccessRun;
}>) {
  const entries = useMemo(() => studioAccessMenuEntries(source), [source]);
  const external = entries.filter((entry) => entry.type === "external");
  return (
    <section aria-label="Pages and menu" className="space-y-4">
      <h2 className="text-xl font-semibold tracking-tight">Pages and menu</h2>
      <p className="text-sm text-muted-foreground">
        A page opens for people who hold its permission, and a menu entry shows for people who hold
        its own. Give the permission to roles in each role&apos;s page.
      </p>
      <div className="overflow-hidden rounded-xl border">
        <Table
          containerClassName="border-0"
          className="[&_tr]:h-11 [&_tr>:first-child]:sticky [&_tr>:first-child]:left-0 [&_tr>:first-child]:bg-card [&_tr]:hover:bg-muted/40 [&_th]:bg-muted/50 [&_th]:normal-case [&_th]:tracking-normal [&_th]:text-foreground"
          aria-label="Who opens each page"
        >
          <TableHeader>
            <TableRow>
              <TableHead>Page</TableHead>
              <TableHead>Opens for people who hold</TableHead>
              <TableHead>Its menu entries show for</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {source.body.pages.map((page) => {
              const own = entries.filter(
                (entry) => entry.type === "page" && entry.page === page.key,
              );
              return (
                <TableRow key={page.id}>
                  <TableCell className="align-top font-medium">{page.name}</TableCell>
                  <TableCell className="align-top">
                    <GateSelect
                      source={source}
                      value={page.permission}
                      label={`Who can open ${page.name}`}
                      disabled={disabled}
                      onGate={(gate) => run({ kind: "set_page_gate", pageAlias: page.id, gate })}
                    />
                  </TableCell>
                  <TableCell className="align-top">
                    {own.length === 0 ? (
                      <span className="text-sm text-muted-foreground">Not in the menu</span>
                    ) : (
                      <div className="space-y-2">
                        {own.map((entry) => (
                          <div key={entry.id} className="space-y-1">
                            <p className="text-sm text-muted-foreground">{entry.label}</p>
                            <GateSelect
                              source={source}
                              value={entry.permission}
                              label={`Who sees the menu entry ${entry.label}`}
                              disabled={disabled}
                              onGate={(gate) =>
                                run({ kind: "set_menu_gate", alias: entry.id, gate })
                              }
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {external.length > 0 && (
        <div className="overflow-hidden rounded-xl border">
          <Table
            containerClassName="border-0"
            className="[&_tr]:h-11 [&_tr>:first-child]:sticky [&_tr>:first-child]:left-0 [&_tr>:first-child]:bg-card [&_tr]:hover:bg-muted/40 [&_th]:bg-muted/50 [&_th]:normal-case [&_th]:tracking-normal [&_th]:text-foreground"
            aria-label="Who sees each link"
          >
            <TableHeader>
              <TableRow>
                <TableHead>Menu link</TableHead>
                <TableHead>Shows for people who hold</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {external.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="font-medium">{entry.label}</TableCell>
                  <TableCell>
                    <GateSelect
                      source={source}
                      value={entry.permission}
                      label={`Who sees the link ${entry.label}`}
                      disabled={disabled}
                      onGate={(gate) => run({ kind: "set_menu_gate", alias: entry.id, gate })}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

/** Every permission the draft declares, who holds it, and adding or removing one. */
export function StudioAccessPermissionList({
  source,
  disabled,
  run,
}: Readonly<{
  source: ApplicationSourceDocument;
  disabled: boolean;
  run: StudioAccessRun;
}>) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const permissions = useMemo(() => studioAccessPermissions(source), [source]);
  const owner = (moduleKey: string | undefined, recordKey: string | undefined) => {
    if (moduleKey === undefined) return "This application";
    const module = source.body.modules.find((entry) => entry.key === moduleKey);
    const record = module?.record_types.find((entry) => entry.key === recordKey);
    return record === undefined
      ? (module?.name ?? moduleKey)
      : `${record.plural_name} (${module!.name})`;
  };
  return (
    <section aria-label="Permissions" className="space-y-6">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xl font-semibold tracking-tight">Permissions</h2>
        <StudioIconButton
          label="New permission"
          disabled={disabled}
          onClick={() => setExpanded("new")}
        >
          <Icon name="plus" />
        </StudioIconButton>
      </div>
      {expanded === "new" && (
        <StudioPermissionDeclaration
          source={source}
          permission={undefined}
          disabled={disabled}
          run={run}
          close={() => setExpanded(null)}
        />
      )}
      <div className="overflow-hidden rounded-xl border">
        <Table
          containerClassName="border-0"
          className="table-fixed [&_tr]:h-11 [&_tr]:hover:bg-muted/40 [&_th]:bg-muted/50 [&_th]:normal-case [&_th]:tracking-normal [&_th]:text-foreground"
          aria-label="Permissions of the application"
        >
          <TableHeader>
            <TableRow>
              <TableHead className="w-1/3">Permission</TableHead>
              <TableHead className="w-1/4">Belongs to</TableHead>
              <TableHead>Held by</TableHead>
              <TableHead className="w-28">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {permissions.map((permission) => {
              const roles = source.body.roles
                .filter(
                  (role) =>
                    role.permissions.includes(permission.key) ||
                    (!permission.administrative && role.permissions.includes("*")),
                )
                .map((role) => role.name);
              const places = applicationUses(source, {
                kind: "permission",
                permissionKey: permission.key,
              });
              const declaration = source.body.permissions.find(
                (entry) =>
                  entry.key === permission.key &&
                  entry.action_kind === "named" &&
                  entry.record_type === undefined,
              );
              return (
                <Fragment key={permission.key}>
                  <TableRow>
                    <TableCell>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <span
                              tabIndex={0}
                              className="block truncate rounded-md font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            />
                          }
                        >
                          {permission.label}
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="font-medium">{permission.label}</p>
                          <p>{permission.description}</p>
                        </TooltipContent>
                      </Tooltip>
                      {permission.administrative && <Badge variant="outline">Administrative</Badge>}
                    </TableCell>
                    <TableCell className="whitespace-normal break-words text-sm">
                      {owner(permission.moduleKey, permission.recordKey)}
                    </TableCell>
                    <TableCell className="whitespace-normal break-words text-sm">
                      {roles.length === 0 ? (
                        <span className="text-muted-foreground">No role</span>
                      ) : (
                        roles.join(", ")
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end">
                        {declaration !== undefined && (
                          <StudioIconButton
                            label={`Edit ${permission.label}`}
                            disabled={disabled}
                            onClick={() =>
                              setExpanded(expanded === permission.key ? null : permission.key)
                            }
                          >
                            <Icon name="sliders-horizontal" />
                          </StudioIconButton>
                        )}
                        <Popover>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <PopoverTrigger
                                  render={
                                    <Button
                                      type="button"
                                      size="icon-xs"
                                      variant="ghost"
                                      aria-label={`Where ${permission.label} is used (${places.length})`}
                                    />
                                  }
                                />
                              }
                            >
                              <Icon name="list-tree" />
                            </TooltipTrigger>
                            <TooltipContent>Used in {places.length} places</TooltipContent>
                          </Tooltip>
                          <PopoverContent className="max-h-80 overflow-y-auto">
                            <PopoverTitle>Where {permission.label} is used</PopoverTitle>
                            {places.length === 0 ? (
                              <p className="text-sm text-muted-foreground">
                                Not used anywhere yet.
                              </p>
                            ) : (
                              <StudioPlaceList
                                places={places}
                                label={`Where ${permission.label} is used`}
                              />
                            )}
                          </PopoverContent>
                        </Popover>
                        {permission.standard ? (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <span
                                  tabIndex={0}
                                  aria-label={`${permission.label} comes with its record type`}
                                  className="flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                />
                              }
                            >
                              <Icon name="shield" className="size-4" />
                            </TooltipTrigger>
                            <TooltipContent>Comes with its record type</TooltipContent>
                          </Tooltip>
                        ) : (
                          <StudioIconButton
                            disabled={disabled}
                            label={`Remove ${permission.label}`}
                            destructive
                            onClick={() =>
                              run({ kind: "remove_permission", permissionKey: permission.key })
                            }
                          >
                            <Icon name="close" />
                          </StudioIconButton>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                  {expanded === permission.key && declaration !== undefined && (
                    <TableRow>
                      <TableCell colSpan={4} className="whitespace-normal py-4">
                        <StudioPermissionDeclaration
                          key={JSON.stringify([
                            declaration.id,
                            declaration.label,
                            declaration.description,
                            declaration.administrative,
                          ])}
                          source={source}
                          permission={declaration}
                          disabled={disabled}
                          run={run}
                          close={() => setExpanded(null)}
                        />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
