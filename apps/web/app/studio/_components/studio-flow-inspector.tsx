"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@vortex/ui/components/button";
import { Label } from "@vortex/ui/components/label";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import { describeFailure, type BlockPropertySchemaContract } from "@vortex/platform/schema";
import {
  StudioSettingFields,
  projectStudioFlowStepActions,
  projectStudioFlowTaskSettings,
  samePath,
  type StudioFlowCalculation,
  type StudioFlowCommand,
  type StudioFlowContext,
  type StudioFlowEditResult,
  type StudioFlowPath,
  type StudioFlowSelection,
  type StudioFlowSettingField,
  type StudioFlowSettingValue,
  type StudioFlowTaskListOutline,
  type StudioFlowTaskOutline,
  type StudioSettingValues,
} from "@vortex/ui/studio";
import { StudioFlowCalculationControl, defaultStudioFlowCalculation } from "./studio-flow-calculation";

/**
 * The Flows tab's inspector: the selected step's settings, drawn with Studio's shared typed setting
 * controls from the step catalogue's declarations, and the step's place in the flow (move, remove,
 * add a step after it, add a branch). With no step selected it describes the flow and adds a first
 * or last step. Every change is one flow command, judged by the flow commands and taken by the draft.
 */

export type StudioFlowRun = (expected: StudioFlowContext, selection: StudioFlowSelection, command: StudioFlowCommand) => StudioFlowEditResult;

const findStep = (lists: readonly StudioFlowTaskListOutline[], path: StudioFlowPath): StudioFlowTaskOutline | undefined => {
  for (const list of lists) for (const task of list.tasks) {
    if (samePath(task.path, path)) return task;
    const child = findStep(task.children, path);
    if (child !== undefined) return child;
  }
  return undefined;
};

export const findStudioFlowStepById = (lists: readonly StudioFlowTaskListOutline[], id: string): StudioFlowTaskOutline | undefined => {
  for (const list of lists) for (const task of list.tasks) {
    if (task.id === id) return task;
    const child = findStudioFlowStepById(task.children, id);
    if (child !== undefined) return child;
  }
  return undefined;
};

/** The shared control a plain flow setting is drawn with. */
const controlProperty = (field: StudioFlowSettingField, recordTypes: readonly Readonly<{ key: string; label: string }>[]):
  BlockPropertySchemaContract | undefined => {
  const base = { key: field.key, label: field.label, required: field.required };
  switch (field.control) {
    case "text": return { ...base, kind: "text", minLength: 0, maxLength: 160 };
    case "long_text": return { ...base, kind: "text", minLength: 0, maxLength: 2_000 };
    case "date": return { ...base, kind: "text", minLength: 0, maxLength: 10, help: "A date written as year-month-day, such as 2026-01-31." };
    case "date_time": return { ...base, kind: "text", minLength: 0, maxLength: 40, help: "A moment written as 2026-01-31T09:30:00Z." };
    case "whole_number": return { ...base, kind: "number", integer: true };
    case "decimal_number": return { ...base, kind: "number", integer: false };
    case "yes_no": return { ...base, kind: "boolean" };
    case "page": return { ...base, kind: "page_reference" };
    case "record_type": return { ...base, kind: "choice", options: recordTypes.map((entry) => ({ ...entry })) };
    default: return undefined;
  }
};

type ControlValue = StudioSettingValues[string];

const toControl = (field: StudioFlowSettingField, value: StudioFlowSettingValue | null): ControlValue | undefined => {
  if (value?.kind !== "plain") return undefined;
  switch (field.control) {
    case "yes_no": return { kind: "boolean", value: value.value === true };
    case "whole_number": case "decimal_number":
      return Number.isFinite(Number(value.value)) ? { kind: "number", value: Number(value.value) } : undefined;
    case "page": return { kind: "page_reference", page: String(value.value) };
    case "record_type": return { kind: "choice", value: String(value.value) };
    default: return { kind: "text", value: String(value.value) };
  }
};

const fromControl = (value: ControlValue | undefined): StudioFlowSettingValue | null => {
  if (value === undefined) return null;
  switch (value.kind) {
    case "boolean": return { kind: "plain", value: value.value };
    case "number": return { kind: "plain", value: String(value.value) };
    case "page_reference": return { kind: "plain", value: value.page };
    case "choice": return { kind: "plain", value: value.value };
    case "text": return { kind: "plain", value: value.value };
    default: return null;
  }
};

function StepTypePicker({ id, label, types, disabled, onAdd, action }: Readonly<{
  id: string; label: string; types: readonly Readonly<{ type: string; title: string; summary: string }>[];
  disabled: boolean; onAdd: (type: string) => void; action: string;
}>) {
  const [type, setType] = useState("");
  const chosen = types.find((entry) => entry.type === type);
  if (types.length === 0) return <p className="text-sm text-muted-foreground">No kind of step can be added to this flow here.</p>;
  return <div className="space-y-1.5">
    <Label htmlFor={id}>{label}</Label>
    <div className="flex gap-2">
      <NativeSelect id={id} className="w-full" disabled={disabled} value={type} onChange={(event) => setType(event.target.value)}>
        <NativeSelectOption value="">Choose a kind of step…</NativeSelectOption>
        {types.map((entry) => <NativeSelectOption key={entry.type} value={entry.type}>{entry.title}</NativeSelectOption>)}
      </NativeSelect>
      <Button type="button" size="sm" disabled={disabled || chosen === undefined}
        onClick={() => { if (chosen !== undefined) { onAdd(chosen.type); setType(""); } }}>{action}</Button>
    </div>
    {chosen === undefined ? null : <p className="text-xs text-muted-foreground">{chosen.summary}</p>}
  </div>;
}

export function StudioFlowInspector({ context, selection, lists, stepPath, starts, ownerNote, pages, recordTypes, disabled,
  onCommand, onSelectStep, onPendingChange }: Readonly<{
  context: StudioFlowContext;
  selection: StudioFlowSelection;
  lists: readonly StudioFlowTaskListOutline[];
  stepPath: StudioFlowPath | null;
  starts: readonly string[];
  /** Who owns the flow when it is not the application itself. */
  ownerNote: string | undefined;
  pages: readonly Readonly<{ key: string; label: string }>[];
  /** The record types of the modules this application owns, as qualified keys and names. */
  recordTypes: readonly Readonly<{ key: string; label: string }>[];
  disabled: boolean;
  onCommand: StudioFlowRun;
  onSelectStep: (path: StudioFlowPath | null) => void;
  onPendingChange: (pending: boolean) => void;
}>) {
  const [confirm, confirmDialog] = useConfirm();
  const step = stepPath === null ? undefined : findStep(lists, stepPath);
  const actions = useMemo(() => projectStudioFlowStepActions(context, selection, step?.path ?? null), [context, selection, step?.path]);
  const settings = useMemo(() => step === undefined ? null : projectStudioFlowTaskSettings(context, selection, step.id, step.path),
    [context, selection, step]);
  // Unapplied setting input, bound to the draft snapshot it was started from.
  const [edits, setEdits] = useState<Readonly<{ expected: StudioFlowContext; values: Readonly<Record<string, StudioFlowSettingValue | null>> }> | null>(null);
  const [problem, setProblem] = useState("");
  const [status, setStatus] = useState("");
  const [focusId, setFocusId] = useState<string | null>(null);
  const pending = useRef(false);
  const report = (next: boolean) => { if (pending.current !== next) { pending.current = next; onPendingChange(next); } };
  useEffect(() => () => onPendingChange(false), [onPendingChange]);

  useEffect(() => {
    if (settings?.kind === "unavailable")
      console.error("[studio] flow step settings are unavailable", { flow: selection.flowAlias, step: step?.id },
        settings.cause === undefined ? settings.reason : describeFailure(settings.cause));
  }, [settings, selection.flowAlias, step?.id]);

  // A step just added is selected once the draft has re-projected with it.
  useEffect(() => {
    if (focusId === null) return;
    const added = findStudioFlowStepById(lists, focusId);
    if (added !== undefined) { onSelectStep(added.path); setFocusId(null); }
  }, [focusId, lists, onSelectStep]);

  const run = (command: StudioFlowCommand, done: string): boolean => {
    const result = onCommand(edits?.expected ?? context, selection, command);
    if (result.kind === "applied") {
      setProblem("");
      setStatus(`${done} Save to keep it.`);
      return true;
    }
    setStatus("");
    setProblem(result.reason);
    return false;
  };
  const add = (command: Extract<StudioFlowCommand, { kind: "insert_task" | "add_branch" }>, done: string) => {
    const result = onCommand(context, selection, command);
    if (result.kind === "applied") { setProblem(""); setStatus(`${done} Save to keep it.`); setFocusId(result.taskId); }
    else { setStatus(""); setProblem(result.reason); }
  };
  const discard = () => { setEdits(null); report(false); setProblem(""); };

  const summary = <div className="space-y-1 text-sm">
    <p className="font-medium">How it starts</p>
    {starts.length === 0 ? <p className="text-muted-foreground">Nothing starts this flow yet: another flow runs it, or bind it to a control.</p>
      : <ul className="list-disc space-y-0.5 pl-5">{starts.map((start) => <li key={start}>{start}</li>)}</ul>}
    {ownerNote === undefined ? null : <p className="text-muted-foreground">{ownerNote}</p>}
  </div>;

  if (step === undefined) {
    const main = lists[0];
    return <div className="space-y-4">
      {summary}
      <p className="text-sm text-muted-foreground">Select a step on the canvas to change its settings, move it or add a step after it.</p>
      {main !== undefined && <StepTypePicker id="flow-add-last" label="Add a step at the end" types={actions.stepTypes} disabled={disabled}
        action="Add" onAdd={(taskType) => add({ kind: "insert_task", taskType, listPath: main.path, index: main.tasks.length }, "Step added at the end.")} />}
      {problem === "" ? null : <p role="alert" className="text-sm text-destructive">{problem}</p>}
      <p role="status" className="text-sm">{status}</p>
      {confirmDialog}
    </div>;
  }

  const fields = settings?.kind === "available" ? settings.fields : [];
  const plain = fields.filter((field) => controlProperty(field, recordTypes) !== undefined);
  const properties = plain.map((field) => controlProperty(field, recordTypes)!);
  const shown = (field: StudioFlowSettingField): StudioFlowSettingValue | null =>
    edits !== null && Object.hasOwn(edits.values, field.key) ? edits.values[field.key]! : field.value;
  const controlValues: StudioSettingValues = Object.fromEntries(plain.flatMap((field) => {
    const value = toControl(field, shown(field));
    return value === undefined ? [] : [[field.key, value]];
  }));
  const change = (key: string, value: StudioFlowSettingValue | null) => {
    setEdits((previous) => ({ expected: previous?.expected ?? context, values: { ...previous?.values, [key]: value } }));
    report(true);
    setProblem(""); setStatus("");
  };
  const index = step.path[step.path.length - 1] as number;
  const listPath = step.path.slice(0, -1);

  return <div className="space-y-4">
    <div className="space-y-1">
      <h3 className="text-sm font-medium">{step.title}</h3>
      <p className="text-sm text-muted-foreground">{step.caption}</p>
    </div>
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" size="sm" disabled={disabled || edits !== null || !actions.canMoveUp}
        onClick={() => { run({ kind: "move_task", taskId: step.id, taskPath: step.path, direction: "up" }, "Step moved up."); }}>Move up</Button>
      <Button type="button" variant="outline" size="sm" disabled={disabled || edits !== null || !actions.canMoveDown}
        onClick={() => { run({ kind: "move_task", taskId: step.id, taskPath: step.path, direction: "down" }, "Step moved down."); }}>Move down</Button>
      <Button type="button" variant="outline" size="sm" disabled={disabled || edits !== null} onClick={() => {
        void (async () => {
          if (!await confirm({ title: `Remove ${step.title}?`, confirmLabel: "Remove step",
            description: step.children.some((child) => child.tasks.length > 0)
              ? "This step and the steps in its branches are removed from the draft. You can undo this before you save."
              : "This step is removed from the draft. You can undo this before you save." })) return;
          if (run({ kind: "remove_task", taskId: step.id, taskPath: step.path }, "Step removed.")) onSelectStep(null);
        })();
      }}>Remove</Button>
    </div>
    <section className="space-y-3" aria-label="Step settings">
      <h4 className="text-sm font-medium">Settings</h4>
      {settings?.kind === "unavailable" && <p role="alert" className="text-sm">{settings.reason}</p>}
      {settings?.kind === "available" && settings.note !== undefined && <p className="text-sm text-muted-foreground">{settings.note}</p>}
      {settings?.kind === "available" && fields.length === 0 && settings.note === undefined &&
        <p className="text-sm text-muted-foreground">This step has no settings.</p>}
      {properties.length > 0 && <StudioSettingFields idPrefix={`flow-step-${step.id}`} properties={properties} values={controlValues}
        choices={{ fields: [], queries: [], pages, recordTypes: [], actions: [], pipelines: [], relationships: [], records: null }}
        disabled={disabled}
        onChange={(next) => {
          for (const field of plain) {
            const before = toControl(field, shown(field));
            const after = Object.hasOwn(next, field.key) ? next[field.key] : undefined;
            if (JSON.stringify(before) !== JSON.stringify(after)) change(field.key, fromControl(after));
          }
        }} />}
      {fields.filter((field) => field.control === "calculation").map((field) => {
        const value = shown(field);
        return <div key={field.key} className="space-y-1.5">
          <p className="text-sm font-medium">{field.label}</p>
          <StudioFlowCalculationControl id={`flow-step-${step.id}-${field.key}`} disabled={disabled}
            references={settings?.kind === "available" ? settings.references : []}
            value={value?.kind === "calculation" ? value.calculation : defaultStudioFlowCalculation}
            onChange={(calculation: StudioFlowCalculation) => change(field.key, { kind: "calculation", calculation })} />
        </div>;
      })}
      {fields.filter((field) => field.control === null).map((field) => <div key={field.key} className="space-y-1 text-sm">
        <p className="font-medium">{field.label}</p>
        <p className="break-words border border-border bg-muted p-2">{field.display}</p>
        {field.note === undefined ? null : <p className="text-xs text-muted-foreground">{field.note}</p>}
      </div>)}
      {(plain.length > 0 || fields.some((field) => field.control === "calculation")) && <div className="flex gap-2">
        <Button type="button" size="sm" disabled={disabled || edits === null} onClick={() => {
          if (edits === null) return;
          if (run({ kind: "set_task_settings", taskId: step.id, taskPath: step.path, values: edits.values }, "Settings changed.")) {
            setEdits(null); report(false);
          }
        }}>Apply</Button>
        <Button type="button" variant="outline" size="sm" disabled={disabled || edits === null} onClick={discard}>Discard</Button>
      </div>}
    </section>
    <section className="space-y-3" aria-label="Add steps">
      <StepTypePicker id="flow-add-after" label="Add a step after this one" types={actions.stepTypes} disabled={disabled || edits !== null}
        action="Add" onAdd={(taskType) => add({ kind: "insert_task", taskType, listPath, index: index + 1 }, "Step added.")} />
      {step.children.map((child) => <StepTypePicker key={JSON.stringify(child.path)} id={`flow-add-in-${JSON.stringify(child.path)}`}
        label={`Add a step to ${child.label}`} types={actions.stepTypes} disabled={disabled || edits !== null} action="Add"
        onAdd={(taskType) => add({ kind: "insert_task", taskType, listPath: child.path, index: child.tasks.length }, `Step added to ${child.label}.`)} />)}
      {actions.branch !== null && <StepTypePicker id="flow-add-branch" label={`Add the ${actions.branch} branch, starting with`}
        types={actions.stepTypes} disabled={disabled || edits !== null} action="Add branch"
        onAdd={(taskType) => add({ kind: "add_branch", taskId: step.id, taskPath: step.path, taskType }, `${actions.branch} branch added.`)} />}
    </section>
    {problem === "" ? null : <p role="alert" className="text-sm text-destructive">{problem}</p>}
    <p role="status" className="text-sm">{status}</p>
    {summary}
    {confirmDialog}
  </div>;
}
