"use client";

import type { ReactElement } from "react";
import type { SourceBlockPropertyValueContract } from "@vortex/platform/schema";
import { StudioField } from "../studio-field";
import { StudioReferencePicker } from "../studio-reference-picker";

type GroupValue = Extract<SourceBlockPropertyValueContract, { kind: "group" }>;

/**
 * The Saved views settings in the Features panel: which of the application's permissions lets
 * people share views and change shared views. It is picked from the permissions the application
 * declares; without one, views stay personal. Who holds the permission is set in Access.
 */
export function StudioSavedViewsEditor({
  value,
  permissions,
  disabled,
  onChange,
}: Readonly<{
  value: GroupValue;
  permissions: readonly Readonly<{ key: string; label: string }>[];
  disabled: boolean;
  onChange: (next: GroupValue) => void;
}>): ReactElement {
  const held = value.properties["share_permission"];
  const chosen = held?.kind === "text" ? held.value : "";
  return (
    <StudioField
      label="Who may share views"
      optional
      hint="People with this permission can share views and change shared views. Give it to roles in Access. Everyone can save personal views."
    >
      {(control) => (
        <StudioReferencePicker
          id={control.id}
          value={chosen}
          unset="Nobody: views stay personal"
          disabled={disabled}
          aria-describedby={control["aria-describedby"]}
          options={permissions.map((permission) => ({
            value: permission.key,
            label: permission.label,
            description: permission.key,
          }))}
          onChange={(next) => {
            const rest = Object.fromEntries(
              Object.entries(value.properties).filter(([key]) => key !== "share_permission"),
            );
            onChange({
              kind: "group",
              properties:
                next === "" ? rest : { ...rest, share_permission: { kind: "text", value: next } },
            });
          }}
        />
      )}
    </StudioField>
  );
}
