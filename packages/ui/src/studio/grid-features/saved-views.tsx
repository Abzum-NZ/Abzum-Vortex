"use client";
import { useState, type ReactElement } from "react";
import type { SourceBlockPropertyValueContract } from "@vortex/platform/schema";
import { Button } from "../../components/button";
import { RotateCcw, Trash2 } from "lucide-react";
import { Input } from "../../components/input";
import { Checkbox } from "../../components/checkbox";
import { StudioField } from "../studio-field";
import { StudioReferencePicker } from "../studio-reference-picker";
import type { StudioSettingValues } from "../studio-setting-controls";

type Group = Extract<SourceBlockPropertyValueContract, { kind: "group" }>;
const text = (value: SourceBlockPropertyValueContract | undefined): string =>
  value?.kind === "text" ? value.value : "";

/** Capture the table configuration displayed by the canvas into the definition's default views. */
export function StudioSavedViewsEditor({
  value,
  tableSettings,
  roles,
  disabled,
  onChange,
}: Readonly<{
  value: Group;
  tableSettings: StudioSettingValues;
  roles: readonly Readonly<{ key: string; label: string }>[];
  disabled: boolean;
  onChange: (value: Group) => void;
}>): ReactElement {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const held = value.properties["default_views"];
  const views =
    held?.kind === "list" ? held.items.filter((item): item is Group => item.kind === "group") : [];
  const write = (items: readonly Group[]): void =>
    onChange({
      ...value,
      properties: { ...value.properties, default_views: { kind: "list", items: [...items] } },
    });
  const capture = (): Group | undefined => {
    const columns = tableSettings["columns"];
    const density = tableSettings["density"];
    if (columns?.kind !== "list" || density?.kind !== "choice") return undefined;
    return {
      kind: "group",
      properties: {
        columns: {
          kind: "list",
          items: columns.items.flatMap((item) => {
            if (item.kind !== "group") return [];
            const { field, visible, pin } = item.properties;
            if (field === undefined || visible === undefined || pin === undefined) return [];
            return [{ kind: "group" as const, properties: { field, visible, pin } }];
          }),
        },
        density,
        sort: tableSettings["default_sort"] ?? { kind: "list", items: [] },
        filters: { kind: "list", items: [] },
      },
    };
  };
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Give roles the Share table views permission in Access to let people share views.
      </p>
      <p className="text-sm">
        Default views capture the authored columns, density and sort. Personal layouts take
        precedence. A role default takes precedence over the app default.
      </p>
      {views.map((view, index) => (
        <div key={text(view.properties["view_id"])} className="flex items-center gap-2">
          <Input
            aria-label="Default view name"
            value={text(view.properties["name"])}
            disabled={disabled}
            onChange={(event) =>
              write(
                views.map((entry, i) =>
                  i === index
                    ? {
                        ...entry,
                        properties: {
                          ...entry.properties,
                          name: { kind: "text", value: event.target.value },
                        },
                      }
                    : entry,
                ),
              )
            }
          />
          <span className="text-sm">
            {text(view.properties["role"]) === "*"
              ? "Everyone"
              : roles.find((role) => role.key === text(view.properties["role"]))?.label}
          </span>
          <Checkbox
            aria-label={`Use ${text(view.properties["name"])} by default`}
            disabled={disabled}
            checked={
              view.properties["is_default"]?.kind === "boolean" &&
              view.properties["is_default"].value
            }
            onCheckedChange={(checked) =>
              write(
                views.map((entry, i) =>
                  i === index
                    ? {
                        ...entry,
                        properties: {
                          ...entry.properties,
                          is_default: { kind: "boolean", value: checked === true },
                        },
                      }
                    : entry,
                ),
              )
            }
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Recapture ${text(view.properties["name"])}`}
            title="Capture current table settings"
            disabled={disabled}
            onClick={() => {
              const state = capture();
              if (state)
                write(
                  views.map((entry, i) =>
                    i === index ? { ...entry, properties: { ...entry.properties, state } } : entry,
                  ),
                );
            }}
          >
            <RotateCcw aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label={`Remove ${text(view.properties["name"])}`}
            onClick={() => write(views.filter((_, i) => i !== index))}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      ))}
      <StudioField label="View name">
        {(control) => (
          <Input
            {...control}
            value={name}
            disabled={disabled}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </StudioField>
      <StudioField label="Who can use it">
        {(control) => (
          <StudioReferencePicker
            {...control}
            value={role}
            disabled={disabled}
            options={[
              { value: "*", label: "Everyone in the app" },
              ...roles.map((role) => ({ value: role.key, label: role.label })),
            ]}
            onChange={setRole}
            unset="Choose everyone or a role"
          />
        )}
      </StudioField>
      <Button
        variant="outline"
        size="sm"
        disabled={
          disabled || !name.trim() || !role || capture() === undefined || views.length >= 20
        }
        onClick={() => {
          const state = capture();
          if (!state) return;
          write([
            ...views,
            {
              kind: "group",
              properties: {
                view_id: { kind: "text", value: crypto.randomUUID() },
                name: { kind: "text", value: name.trim() },
                role: { kind: "text", value: role },
                is_default: {
                  kind: "boolean",
                  value: !views.some(
                    (view) =>
                      text(view.properties["role"]) === role &&
                      view.properties["is_default"]?.kind === "boolean" &&
                      view.properties["is_default"].value,
                  ),
                },
                state,
              },
            },
          ]);
          setName("");
        }}
      >
        Capture table as view
      </Button>
    </div>
  );
}
