"use client";
import { useState, type FormEvent } from "react";
import type { ApplicationSourceDocument } from "@vortex/platform/schema";
import { Icon } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";
import { Textarea } from "@vortex/ui/components/textarea";
import { Switch } from "@vortex/ui/components/switch";
import { StudioField, StudioIconButton, StudioInspectorGroup } from "@vortex/ui/studio";
import type { StudioAccessRun } from "./studio-access-role";

type Permission = ApplicationSourceDocument["body"]["permissions"][number];

/** One declaration editor; identities and grants are changed only by their existing commands. */
export function StudioPermissionDeclaration({
  source,
  permission,
  disabled,
  run,
  close,
}: Readonly<{
  source: ApplicationSourceDocument;
  permission: Permission | undefined;
  disabled: boolean;
  run: StudioAccessRun;
  close: () => void;
}>) {
  const [label, setLabel] = useState(permission?.label ?? "");
  const [description, setDescription] = useState(permission?.description ?? "");
  const [administrative, setAdministrative] = useState(permission?.administrative ?? false);
  const explicit = source.body.roles.filter(
    (role) => permission !== undefined && role.permissions.includes(permission.key),
  );
  const wildcard = source.body.roles.filter((role) => role.permissions.includes("*"));
  const names = (roles: typeof explicit) =>
    roles.map((role) => role.name + (role.default_member ? " (default member)" : "")).join(", ");
  const changed = permission !== undefined && permission.administrative !== administrative;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const declaration = { label, description, administrative };
    if (
      run(
        permission === undefined
          ? { kind: "add_permission", ...declaration }
          : { kind: "edit_permission", permissionKey: permission.key, ...declaration },
      )
    )
      close();
  };
  return (
    <form
      aria-label={permission === undefined ? "New permission" : `Edit ${permission.label}`}
      className="space-y-4"
      onSubmit={submit}
    >
      <StudioField label="Label">
        {(control) => (
          <Input
            {...control}
            required
            maxLength={60}
            autoFocus
            disabled={disabled}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        )}
      </StudioField>
      <StudioField label="Description">
        {(control) => (
          <Textarea
            {...control}
            required
            maxLength={1000}
            disabled={disabled}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        )}
      </StudioField>
      <StudioField
        label="Administrative"
        hint="Requires a privileged organisation role to grant this permission."
      >
        {(control) => (
          <div>
            <Switch
              {...control}
              disabled={disabled}
              checked={administrative}
              onCheckedChange={setAdministrative}
            />
          </div>
        )}
      </StudioField>
      <div aria-label="Role impact" className="space-y-2 text-sm" aria-live="polite">
        <p className="font-medium">Role impact{changed ? " after publishing" : ""}</p>
        <p>
          {explicit.length === 0
            ? "No role has an explicit grant."
            : `Explicit grants stay with: ${names(explicit)}.`}
        </p>
        <p>
          {wildcard.length === 0
            ? "No role uses every application permission."
            : `Roles using every application permission ${administrative ? (changed ? "will lose" : "exclude") : changed ? "will gain" : "include"} this permission: ${names(wildcard)}.`}
        </p>
        {administrative && (
          <p className="text-muted-foreground">
            Organisation role protection and acceptance rules still apply. This does not grant
            access to members automatically.
          </p>
        )}
      </div>
      <StudioInspectorGroup title="Details" defaultOpen={false}>
        {permission === undefined ? (
          <p className="text-sm text-muted-foreground">
            The key and named action are generated from the first label and stay fixed when it
            changes.
          </p>
        ) : (
          <dl className="grid gap-2 text-xs">
            <dt>Key</dt>
            <dd className="break-all font-mono">{permission.key}</dd>
            <dt>Named action</dt>
            <dd className="break-all font-mono">{permission.named_action}</dd>
            <dt>Identity</dt>
            <dd className="break-all font-mono">{permission.id}</dd>
          </dl>
        )}
      </StudioInspectorGroup>
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          disabled={disabled || !label.trim() || !description.trim()}
        >
          <Icon name="check" />
          {permission === undefined ? "Add permission" : "Save permission"}
        </Button>
        <StudioIconButton label="Cancel permission edit" onClick={close}>
          <Icon name="close" />
        </StudioIconButton>
      </div>
    </form>
  );
}
