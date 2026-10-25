"use client";
import { useState, type FormEvent } from "react";
import type { ApplicationSourceDocument } from "@vortex/platform/schema";
import { Icon } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import { Switch } from "@vortex/ui/components/switch";
import {
  StudioIconButton,
  StudioInspectorGroup,
  studioStandardFieldPolicy,
} from "@vortex/ui/studio";
import type { StudioAccessRun } from "./studio-access-role";

/**
 * The fields one standard record permission (Read, Create, Update, Delete, Restore or Export) lets
 * people read and change. Its name and scope come with the record type; only its fields change
 * here, and every role holding it gets them.
 */
export function StudioStandardFieldPolicy({
  source,
  permissionKey,
  disabled,
  run,
  close,
}: Readonly<{
  source: ApplicationSourceDocument;
  permissionKey: string;
  disabled: boolean;
  run: StudioAccessRun;
  close: () => void;
}>) {
  const policy = studioStandardFieldPolicy(source, permissionKey);
  const available = policy.kind === "available" ? policy : undefined;
  const [readable, setReadable] = useState<readonly string[]>(
    available?.fields.filter((field) => field.readable).map((field) => field.key) ?? [],
  );
  const [changeable, setChangeable] = useState<readonly string[]>(
    available?.fields
      .filter((field) => field.changeable && !field.producedByPlatform)
      .map((field) => field.key) ?? [],
  );
  if (available === undefined)
    return (
      <p className="text-sm text-muted-foreground">
        {policy.kind === "unavailable" ? policy.message : ""}
      </p>
    );
  // A field the platform fills that the stored list still names: saving removes it.
  const staleProduced = available.fields.filter(
    (field) => field.producedByPlatform && field.changeable,
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      run({
        kind: "set_standard_field_policy",
        permissionKey,
        readableFields: readable,
        changeableFields: available.changesFields ? changeable : [],
      })
    )
      close();
  };
  return (
    <form aria-label={`Fields of ${available.label}`} className="space-y-4" onSubmit={submit}>
      <StudioInspectorGroup title={`Fields of ${available.label}`}>
        <p className="text-sm text-muted-foreground">
          {available.changesFields
            ? `Choose the ${available.recordName} fields this permission reads and changes. A changed field is read too.`
            : available.needsReadableField
              ? `Choose the ${available.recordName} fields this permission reads. Keep at least one.`
              : `Choose the ${available.recordName} fields this permission reads. It may read none.`}
        </p>
        <p className="text-sm text-muted-foreground">
          {available.roles.length === 0
            ? "No role holds it yet. Its name and scope come with the record type."
            : `Every role holding it gets these fields: ${available.roles.join(", ")}. Its name and scope come with the record type.`}
        </p>
        <div className="flex justify-end gap-3 text-xs text-muted-foreground" aria-hidden="true">
          <span className="w-8 text-center">Read</span>
          {available.changesFields && <span className="w-8 text-center">Change</span>}
        </div>
        {available.fields.map((field) => (
          <div
            key={field.key}
            className="flex items-center justify-between gap-3 py-1 text-sm hover:bg-muted/40"
          >
            <span>{field.label}</span>
            <div className="flex items-center gap-3">
              <Switch
                aria-label={`Read ${field.label}`}
                disabled={disabled}
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
              {available.changesFields && (
                <Switch
                  aria-label={`Change ${field.label}`}
                  disabled={disabled || field.producedByPlatform}
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
        {staleProduced.length > 0 && (
          <p className="text-sm text-muted-foreground" role="status">
            The platform fills {staleProduced.map((field) => field.label).join(", ")}, so saving
            removes {staleProduced.length === 1 ? "it" : "them"} from the fields people change.
          </p>
        )}
      </StudioInspectorGroup>
      <div className="flex items-center gap-2">
        <Button type="submit" variant="secondary" size="sm" disabled={disabled}>
          <Icon name="check" />
          Save fields
        </Button>
        <StudioIconButton label="Cancel field edit" onClick={close}>
          <Icon name="close" />
        </StudioIconButton>
      </div>
    </form>
  );
}
