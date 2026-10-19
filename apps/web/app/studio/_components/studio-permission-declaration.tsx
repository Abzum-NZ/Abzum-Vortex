"use client";
import { useState, type FormEvent } from "react";
import type { ApplicationSourceDocument } from "@vortex/platform/schema";
import { Icon } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";
import { Textarea } from "@vortex/ui/components/textarea";
import { Switch } from "@vortex/ui/components/switch";
import {
  StudioField,
  StudioIconButton,
  StudioInspectorGroup,
  StudioReferencePicker,
  type StudioPermissionDeclaration as Declaration,
} from "@vortex/ui/studio";
import { applicationUses, changeableByPeople } from "@vortex/platform/schema";
import { StudioPlaceList } from "./studio-used-in";
import type { StudioAccessRun } from "./studio-access-role";

type Permission = ApplicationSourceDocument["body"]["permissions"][number];

/** One declaration editor; identities and grants are changed only by their existing commands. */
export function StudioPermissionDeclaration({
  source,
  permission,
  moduleKey,
  disabled,
  run,
  close,
}: Readonly<{
  source: ApplicationSourceDocument;
  permission: Permission | undefined;
  moduleKey?: string | undefined;
  disabled: boolean;
  run: StudioAccessRun;
  close: () => void;
}>) {
  const [label, setLabel] = useState(permission?.label ?? "");
  const [description, setDescription] = useState(permission?.description ?? "");
  const [administrative, setAdministrative] = useState(permission?.administrative ?? false);
  const [owner, setOwner] = useState(moduleKey ?? "application");
  const [recordKey, setRecordKey] = useState(permission?.record_type ?? "");
  const [actionKind, setActionKind] = useState<"read" | "named">(
    permission?.action_kind === "read" ? "read" : "named",
  );
  const [namedAction, setNamedAction] = useState(permission?.named_action ?? "");
  const [scope, setScope] = useState<NonNullable<Permission["record_scope"]>>(
    permission?.record_scope ?? { routes: [{ kind: "all_records" }] },
  );
  const [readable, setReadable] = useState(permission?.field_policy?.readable_fields ?? []);
  const [changeable, setChangeable] = useState(permission?.field_policy?.changeable_fields ?? []);
  const record = source.body.modules
    .find((module) => module.key === owner)
    ?.record_types.find((entry) => entry.key === recordKey);
  const recordPermission = owner !== "application";
  const unsupportedScope =
    scope.saved_condition !== undefined ||
    scope.routes.some((route) => route.kind === "relationship");
  const places =
    permission === undefined
      ? []
      : applicationUses(source, { kind: "permission", permissionKey: permission.key });
  const explicit = source.body.roles.filter(
    (role) => permission !== undefined && role.permissions.includes(permission.key),
  );
  const wildcard = source.body.roles.filter((role) => role.permissions.includes("*"));
  const names = (roles: typeof explicit) =>
    roles.map((role) => role.name + (role.default_member ? " (default member)" : "")).join(", ");
  const changed = permission !== undefined && permission.administrative !== administrative;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target: Declaration["target"] = recordPermission
      ? {
          kind: "record",
          moduleKey: owner,
          recordKey,
          actionKind,
          ...(actionKind === "named"
            ? { namedAction: namedAction.trim().toLowerCase().replace(/\s+/g, "_") }
            : {}),
          recordScope: scope,
          fieldPolicy: {
            readable_fields: readable,
            changeable_fields: actionKind === "read" ? [] : changeable,
          },
        }
      : { kind: "application" };
    const declaration = { label, description, administrative, target };
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
      <StudioField label="Belongs to">
        {(control) => (
          <StudioReferencePicker
            {...control}
            value={owner}
            disabled={disabled || permission !== undefined}
            options={[
              { value: "application", label: "Application" },
              ...source.body.modules.map((module) => ({ value: module.key, label: module.name })),
            ]}
            onChange={(value) => {
              setOwner(value);
              setRecordKey("");
              setReadable([]);
              setChangeable([]);
              setScope({ routes: [{ kind: "all_records" }] });
            }}
          />
        )}
      </StudioField>
      {recordPermission && (
        <>
          <StudioField label="Record type">
            {(control) => (
              <StudioReferencePicker
                {...control}
                value={recordKey}
                disabled={disabled || permission !== undefined}
                options={(
                  source.body.modules.find((module) => module.key === owner)?.record_types ?? []
                ).map((entry) => ({ value: entry.key, label: entry.plural_name }))}
                onChange={(value) => {
                  setRecordKey(value);
                  setReadable([]);
                  setChangeable([]);
                  setScope({ routes: [{ kind: "all_records" }] });
                }}
              />
            )}
          </StudioField>
          <StudioField label="Permission kind">
            {(control) => (
              <StudioReferencePicker
                {...control}
                value={actionKind}
                disabled={disabled || permission !== undefined}
                options={[
                  { value: "read", label: "Read" },
                  { value: "named", label: "Named" },
                ]}
                onChange={(value) => {
                  setActionKind(value as "read" | "named");
                  setChangeable([]);
                }}
              />
            )}
          </StudioField>
          {actionKind === "named" && (
            <StudioField
              label="Action name"
              hint="For example: Manage. This identity stays fixed after creation."
            >
              {(control) => (
                <Input
                  {...control}
                  required
                  value={namedAction}
                  maxLength={40}
                  disabled={disabled || permission !== undefined}
                  onChange={(event) => setNamedAction(event.target.value)}
                />
              )}
            </StudioField>
          )}
          <StudioField label="Record scope">
            {(control) => (
              <StudioReferencePicker
                {...control}
                disabled={disabled || unsupportedScope}
                value={
                  unsupportedScope
                    ? "advanced"
                    : scope.routes.length > 1
                      ? "ownership_and_share"
                      : scope.routes[0]!.kind
                }
                options={[
                  { value: "all_records", label: "All records" },
                  ...(record?.ownership_mode !== "none"
                    ? [
                        { value: "ownership", label: "Owned records" },
                        { value: "ownership_and_share", label: "Owned or directly shared records" },
                      ]
                    : []),
                  { value: "direct_share", label: "Directly shared records" },
                  ...(unsupportedScope
                    ? [{ value: "advanced", label: "Relationship or saved condition scope" }]
                    : []),
                ]}
                onChange={(value) =>
                  setScope({
                    routes:
                      value === "ownership_and_share"
                        ? [{ kind: "ownership" }, { kind: "direct_share" }]
                        : [{ kind: value as "all_records" | "ownership" | "direct_share" }],
                  })
                }
              />
            )}
          </StudioField>
          <StudioInspectorGroup title="Fields">
            <p className="text-sm text-muted-foreground">
              {actionKind === "read"
                ? "Choose the fields this permission lets people read. It allows no changes."
                : "Choose readable and changeable fields. Both lists may be empty."}
            </p>
            <div
              className="flex justify-end gap-3 text-xs text-muted-foreground"
              aria-hidden="true"
            >
              <span className="w-8 text-center">Read</span>
              {actionKind === "named" && <span className="w-8 text-center">Change</span>}
            </div>
            {record?.fields.map((field) => (
              <div
                key={field.key}
                className="flex items-center justify-between gap-3 py-1 text-sm hover:bg-muted/40"
              >
                <span>{field.label}</span>
                <div className="flex items-center gap-3">
                  <Switch
                    aria-label={`Read ${field.label}`}
                    disabled={disabled || unsupportedScope}
                    checked={readable.includes(field.key)}
                    onCheckedChange={(checked) => {
                      setReadable(
                        checked
                          ? [...readable, field.key]
                          : readable.filter((key) => key !== field.key),
                      );
                      if (!checked) setChangeable(changeable.filter((key) => key !== field.key));
                    }}
                  />
                  {actionKind === "named" && (
                    <Switch
                      aria-label={`Change ${field.label}`}
                      disabled={disabled || unsupportedScope || !changeableByPeople(field)}
                      checked={changeable.includes(field.key)}
                      onCheckedChange={(checked) => {
                        setChangeable(
                          checked
                            ? [...changeable, field.key]
                            : changeable.filter((key) => key !== field.key),
                        );
                        if (checked && !readable.includes(field.key))
                          setReadable([...readable, field.key]);
                      }}
                    />
                  )}
                </div>
              </div>
            ))}
          </StudioInspectorGroup>
        </>
      )}
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
          {recordPermission
            ? "Only roles you explicitly grant receive this standalone record permission."
            : wildcard.length === 0
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
      {places.length > 0 && (
        <StudioInspectorGroup title="Used in" defaultOpen={false}>
          <StudioPlaceList places={places} label="Where this permission is used" />
        </StudioInspectorGroup>
      )}
      <StudioInspectorGroup title="Details" defaultOpen={false}>
        {permission === undefined ? (
          <p className="text-sm text-muted-foreground">
            The key is generated from the first label for Read, or the action name for Named. The
            owner, kind and identity stay fixed after creation.
          </p>
        ) : (
          <dl className="grid gap-2 text-xs">
            <dt>Key</dt>
            <dd className="break-all font-mono">{permission.key}</dd>
            {permission.named_action !== undefined && (
              <>
                <dt>Named action</dt>
                <dd className="break-all font-mono">{permission.named_action}</dd>
              </>
            )}
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
          disabled={
            disabled ||
            unsupportedScope ||
            !label.trim() ||
            !description.trim() ||
            (recordPermission &&
              (record === undefined || (actionKind === "named" && !namedAction.trim())))
          }
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
