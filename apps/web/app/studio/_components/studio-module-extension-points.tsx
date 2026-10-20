"use client";
import { useState, type FormEvent } from "react";
import {
  changeInlineModuleExtensionPoint,
  moduleExtensionPointName,
  type ApplicationSourceDocument,
  type ModuleExtensionPointUse,
} from "@vortex/platform/schema";
import { Icon } from "@vortex/ui";
import { StudioInspectorGroup, StudioReferencePicker } from "@vortex/ui/studio";
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";
import { Switch } from "@vortex/ui/components/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@vortex/ui/components/tooltip";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import { studioEditProblem, type StudioDataEdit } from "../_lib/studio-data-model";
import { StudioField } from "./studio-field";
import { StudioReferencesAlert } from "./studio-used-in";

type Module = ApplicationSourceDocument["body"]["modules"][number];
type Point = Module["extension_points"][number];

function ExtensionEditor({
  module,
  point,
  disabled,
  uses,
  edit,
  close,
}: Readonly<{
  module: Module;
  point?: Point;
  disabled: boolean;
  uses: readonly ModuleExtensionPointUse[];
  edit: StudioDataEdit;
  close: () => void;
}>) {
  const [recordKey, setRecordKey] = useState(
    point?.record_type ?? module.record_types[0]?.key ?? "",
  );
  const [accepts, setAccepts] = useState<readonly string[]>(point?.accepts ?? ["field"]);
  const [customKey, setCustomKey] = useState<string>();
  const key =
    point?.key ??
    customKey ??
    `${recordKey}_${accepts.length === 1 && accepts[0] === "action" ? "actions" : "fields"}`;
  const [problem, setProblem] = useState<string>();
  const [field, setField] = useState<"key" | "record" | "accepts">();
  const [references, setReferences] = useState<
    Parameters<typeof StudioReferencesAlert>[0]["references"]
  >([]);
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = edit((source) =>
      changeInlineModuleExtensionPoint(
        source,
        {
          operation: "save",
          moduleKey: module.key,
          ...(point === undefined ? {} : { pointId: point.id }),
          key,
          recordKey,
          accepts,
        },
        uses,
      ),
    );
    setProblem(studioEditProblem(result));
    setField(result.kind === "invalid" ? result.field : undefined);
    setReferences(result.kind === "referenced" ? result.references : []);
    if (result.kind === "changed") close();
  };
  return (
    <form
      className="space-y-3 py-3"
      aria-label={
        point === undefined ? "New extension" : `Edit ${moduleExtensionPointName(point.key)}`
      }
      onSubmit={save}
      noValidate
    >
      <StudioField label="Record type" error={field === "record" ? problem : undefined}>
        {(control) => (
          <StudioReferencePicker
            {...control}
            value={recordKey}
            disabled={disabled}
            options={module.record_types.map((record) => ({
              value: record.key,
              label: record.name,
            }))}
            onChange={setRecordKey}
          />
        )}
      </StudioField>
      {(["field", "action"] as const).map((kind) => (
        <StudioField
          key={kind}
          label={kind === "field" ? "Fields" : "Actions"}
          error={field === "accepts" && kind === "field" ? problem : undefined}
        >
          {(control) => (
            <Switch
              {...control}
              checked={accepts.includes(kind)}
              disabled={disabled}
              onCheckedChange={(checked) =>
                setAccepts(checked ? [...accepts, kind] : accepts.filter((entry) => entry !== kind))
              }
            />
          )}
        </StudioField>
      ))}
      <StudioInspectorGroup title="Details" defaultOpen={false}>
        <StudioField
          label="Extension key"
          hint="Permanent once added. Other modules use this key."
          error={field === "key" ? problem : undefined}
        >
          {(control) => (
            <Input
              {...control}
              value={key}
              maxLength={40}
              disabled={disabled || point !== undefined}
              onChange={(event) => setCustomKey(event.target.value)}
            />
          )}
        </StudioField>
      </StudioInspectorGroup>
      {(field !== undefined && field !== "key") || problem === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      <StudioReferencesAlert
        name={moduleExtensionPointName(key)}
        action="changed"
        references={references}
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={disabled}>
          {point === undefined ? "Add extension" : "Save extension"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={close}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The owned module's declarations, through the draft's one edit, undo and autosave path. */
export function StudioModuleExtensionPoints({
  source,
  moduleKey,
  disabled,
  uses,
  edit,
}: Readonly<{
  source: ApplicationSourceDocument;
  moduleKey: string;
  disabled: boolean;
  uses: readonly ModuleExtensionPointUse[] | null;
  edit: StudioDataEdit;
}>) {
  const module = source.body.modules.find((item) => item.key === moduleKey)!;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [problem, setProblem] = useState<string>();
  const [references, setReferences] = useState<
    Parameters<typeof StudioReferencesAlert>[0]["references"]
  >([]);
  const [confirm, confirmDialog] = useConfirm();
  const locked = disabled || uses === null;
  const remove = async (point: Point) => {
    if (uses === null) return;
    const check = changeInlineModuleExtensionPoint(
      source,
      { operation: "remove", moduleKey, pointId: point.id },
      uses,
    );
    setProblem(studioEditProblem(check));
    setReferences(check.kind === "referenced" ? check.references : []);
    if (check.kind !== "changed") return;
    if (
      !(await confirm({
        title: `Delete ${moduleExtensionPointName(point.key)}?`,
        description:
          "The declaration leaves this draft. You can undo this change before publishing.",
        confirmLabel: "Delete extension",
      }))
    )
      return;
    const result = edit((current) =>
      changeInlineModuleExtensionPoint(
        current,
        { operation: "remove", moduleKey, pointId: point.id },
        uses,
      ),
    );
    setProblem(studioEditProblem(result));
    setReferences(result.kind === "referenced" ? result.references : []);
    if (result.kind === "changed") setExpanded(null);
  };
  return (
    <StudioInspectorGroup title="Extensions">
      <p className="text-sm text-muted-foreground">
        Allow other modules to add fields or actions to your record types.
      </p>
      {module.extension_points.map((point) => {
        const name = moduleExtensionPointName(point.key);
        return (
          <div key={point.id}>
            <div className="flex items-center gap-2 rounded-md py-2 hover:bg-muted/50">
              <div className="mr-auto min-w-0 text-sm">
                <p className="break-words">{name}</p>
                <p className="text-xs text-muted-foreground">
                  {module.record_types.find((record) => record.key === point.record_type)?.name ??
                    point.record_type}{" "}
                  ·{" "}
                  {point.accepts
                    .map((kind) => (kind === "field" ? "Fields" : "Actions"))
                    .join(", ")}
                </p>
              </div>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Edit ${name}`}
                      aria-expanded={expanded === point.id}
                      disabled={locked}
                      onClick={() => setExpanded(expanded === point.id ? null : point.id)}
                    />
                  }
                >
                  <Icon name="sliders-horizontal" />
                </TooltipTrigger>
                <TooltipContent>Edit {name}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Delete ${name}`}
                      disabled={locked}
                      onClick={() => {
                        void remove(point);
                      }}
                    />
                  }
                >
                  <Icon name="minus" />
                </TooltipTrigger>
                <TooltipContent>Delete {name}</TooltipContent>
              </Tooltip>
            </div>
            {expanded === point.id && (
              <ExtensionEditor
                key={JSON.stringify(point)}
                module={module}
                point={point}
                disabled={locked}
                uses={uses ?? []}
                edit={edit}
                close={() => setExpanded(null)}
              />
            )}
          </div>
        );
      })}
      {problem === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      <StudioReferencesAlert name="This extension" action="deleted" references={references} />
      {expanded === "new" ? (
        <ExtensionEditor
          module={module}
          disabled={locked}
          uses={uses ?? []}
          edit={edit}
          close={() => setExpanded(null)}
        />
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={locked || module.record_types.length === 0}
          onClick={() => setExpanded("new")}
        >
          <Icon name="plus" />
          Add extension
        </Button>
      )}
      {uses === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading extension uses…
        </p>
      ) : null}
      {confirmDialog}
    </StudioInspectorGroup>
  );
}
