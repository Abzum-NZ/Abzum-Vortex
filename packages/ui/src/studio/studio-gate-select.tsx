"use client";
import { useMemo, useState, type FormEvent } from "react";
import type { ApplicationSourceDocument } from "@vortex/platform/schema";
import { Button } from "../components/button";
import { Input } from "../components/input";
import {
  studioAccessGateChoices,
  studioAccessPermissions,
  type StudioAccessGate,
} from "./application-access-commands";
import { StudioField } from "./studio-field";
import { StudioReferencePicker } from "./studio-reference-picker";

const newChoice = "__new__";

/** The one permission picker for page, menu and block gates, including naming a new permission. */
export function StudioGateSelect({
  id,
  source,
  value,
  label,
  disabled,
  onGate,
  onClear,
  allowCreate = true,
  unsetLabel = "No block permission gate",
  ...accessibility
}: Readonly<{
  id?: string | undefined;
  "aria-describedby"?: string | undefined;
  "aria-invalid"?: boolean | undefined;
  source: ApplicationSourceDocument;
  value: string;
  label: string;
  disabled: boolean;
  onGate: (gate: StudioAccessGate) => boolean;
  /** Only block gates are optional; clearing leaves the containing page's access in force. */
  onClear?: (() => boolean) | undefined;
  allowCreate?: boolean;
  /** What the empty choice says when the gate can be cleared. */
  unsetLabel?: string;
}>) {
  const choices = useMemo(() => studioAccessGateChoices(source), [source]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const unoffered = value !== "" && !choices.some((choice) => choice.key === value);
  const current = unoffered
    ? studioAccessPermissions(source).find((permission) => permission.key === value)
    : undefined;
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
        {...accessibility}
        id={id}
        aria-label={label}
        value={creating ? newChoice : value}
        disabled={disabled}
        unset={onClear === undefined ? undefined : unsetLabel}
        options={[
          ...(unoffered
            ? [
                {
                  value,
                  label: current?.label ?? value,
                  description: "Current gate (not offered)",
                  disabled: true,
                },
              ]
            : []),
          ...choices.map((choice) => ({
            value: choice.key,
            label: choice.label,
            description: choice.roles.length === 0 ? "No role yet" : choice.roles.join(", "),
          })),
          ...(allowCreate ? [{ value: newChoice, label: "New permission" }] : []),
        ]}
        onChange={(key) => {
          setCreating(key === newChoice);
          if (key === "") onClear?.();
          else if (key !== newChoice) onGate({ kind: "existing", key });
        }}
      />
      {allowCreate && creating && (
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
