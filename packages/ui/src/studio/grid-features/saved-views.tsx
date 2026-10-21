"use client";
import { useState, type ReactElement } from "react";
import type { SourceBlockPropertyValueContract } from "@vortex/platform/schema";
import { Button } from "../../components/button";
import { RotateCcw, Trash2 } from "lucide-react";
import { Input } from "../../components/input";
import { Label } from "../../components/label";
import { Checkbox } from "../../components/checkbox";
import { StudioField } from "../studio-field";
import { StudioReferencePicker } from "../studio-reference-picker";

type Group = Extract<SourceBlockPropertyValueContract, { kind: "group" }>;
const text = (value: SourceBlockPropertyValueContract | undefined): string =>
  value?.kind === "text" ? value.value : "";

const count = (value: SourceBlockPropertyValueContract | undefined): number =>
  value?.kind === "list" ? value.items.length : 0;

/** What a view state holds, in the words the builder reviews it by. */
const arrangementSummary = (state: SourceBlockPropertyValueContract | undefined): string => {
  const columns = state?.kind === "group" ? state.properties["columns"] : undefined;
  const density = state?.kind === "group" ? state.properties["density"] : undefined;
  // Read as the platform reader reads a view: an absent list is empty.
  if (state?.kind !== "group" || density?.kind !== "choice")
    return "This view's layout cannot be read; capture it again";
  const items = columns?.kind === "list" ? columns.items : [];
  const groups = items.flatMap((column) => (column.kind === "group" ? [column] : []));
  const visible = groups.filter(
    (column) =>
      column.properties["visible"]?.kind === "boolean" && column.properties["visible"].value,
  ).length;
  const pinned = groups.filter(
    (column) =>
      column.properties["pin"]?.kind === "choice" && column.properties["pin"].value !== "unpinned",
  ).length;
  const widths = groups.flatMap((column) => {
    const width = column.properties["width"];
    return width?.kind === "number" ? [`${width.value} px`] : [];
  });
  const search = state.properties["search"];
  const sorted = count(state.properties["sort"]);
  const filtered = count(state.properties["filters"]);
  return [
    density.value === "compact" ? "Compact" : "Comfortable",
    `${visible} of ${items.length} columns shown`,
    ...(pinned === 0 ? [] : [`${pinned} pinned`]),
    ...(widths.length === 0 ? [] : [`Resized widths: ${widths.join(", ")}`]),
    sorted === 0 ? "Default order" : `Sorted by ${sorted} ${sorted === 1 ? "field" : "fields"}`,
    ...(filtered === 0 ? [] : [`${filtered} ${filtered === 1 ? "filter" : "filters"}`]),
    ...(search?.kind === "text" ? [`Search “${search.value}”`] : []),
  ].join(" · ");
};

/** Capture the table configuration displayed by the canvas into the definition's default views. */
export function StudioSavedViewsEditor({
  value,
  canvasArrangement,
  canvasStale,
  roles,
  disabled,
  onChange,
}: Readonly<{
  value: Group;
  canvasArrangement?: Group | undefined;
  /** The canvas held an arrangement that no longer matches the table's source, query or columns. */
  canvasStale: boolean;
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
  const personalFormatting = value.properties["personal_formatting"];
  // The captured state is exactly what the canvas shows: its arrangement, order, filters and search.
  const capture = (): Group | undefined => canvasArrangement;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Give roles the Share table views permission in Access to let people share views.
      </p>
      <Label className="gap-2 font-normal">
        <Checkbox
          disabled={disabled}
          checked={personalFormatting?.kind === "boolean" && personalFormatting.value}
          onCheckedChange={(checked) =>
            onChange({
              ...value,
              properties: {
                ...value.properties,
                personal_formatting: { kind: "boolean", value: checked === true },
              },
            })
          }
        />
        Allow personal formatting
      </Label>
      <p className="text-sm text-muted-foreground">
        People add their own highlighting rules to the views they save, on the fields they can read.
        It needs Formatting turned on for this table.
      </p>
      <p className="text-sm">
        Turn on Arrange grid columns above the canvas, then move, resize or hide columns, choose a
        density, sort, filter or search. Capture what the canvas shows here. Personal layouts take
        precedence over defaults; a role default takes precedence over the app default.
      </p>
      {canvasArrangement === undefined ? (
        <p className="text-sm text-muted-foreground">
          Capturing waits for the grid on the canvas to show its columns: turn on Arrange grid
          columns and save the page if the grid says it needs a save.
        </p>
      ) : null}
      {views.map((view, index) => (
        <div key={text(view.properties["view_id"])} className="space-y-1">
          <div className="flex items-center gap-2">
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
              aria-label={`Use canvas arrangement for ${text(view.properties["name"])}`}
              title="Use the canvas arrangement"
              disabled={disabled || canvasArrangement === undefined}
              onClick={() => {
                const state = capture();
                if (state)
                  write(
                    views.map((entry, i) =>
                      i === index
                        ? { ...entry, properties: { ...entry.properties, state } }
                        : entry,
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
          <p className="text-sm text-muted-foreground">
            {arrangementSummary(view.properties["state"])}
          </p>
        </div>
      ))}
      {canvasStale && (
        <p role="status" className="text-sm text-muted-foreground">
          The table's source, query or columns changed after the canvas was arranged, so that
          arrangement is no longer captured. Arrange the grid again to capture it.
        </p>
      )}
      {canvasArrangement !== undefined && (
        <p className="text-sm">On the canvas now: {arrangementSummary(canvasArrangement)}</p>
      )}
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
        Use the canvas arrangement
      </Button>
    </div>
  );
}
