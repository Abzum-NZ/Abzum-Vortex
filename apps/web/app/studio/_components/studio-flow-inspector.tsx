"use client";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@vortex/ui/components/button";
import { Label } from "@vortex/ui/components/label";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import { describeFailure, type SourceFlow } from "@vortex/platform/schema";
import {
  projectStudioFlowStepActions, projectStudioFlowStepForm, refreshStudioFlowStepFields, samePath,
  studioFlowConditionContext, studioFlowOutline, studioFlowReferenceChoices,
  type StudioFlowCommand, type StudioFlowContext, type StudioFlowDraftChoices, type StudioFlowEditResult, type StudioFlowPath,
  type StudioFlowSelection, type StudioFlowStartDraft, type StudioFlowStartProjection, type StudioFlowStepDraft,
  type StudioFlowTaskListOutline, type StudioFlowTaskOutline,
} from "@vortex/ui/studio";
import { StudioFlowStepForm } from "./studio-flow-step-form";
import { StudioFlowStartEditor } from "./studio-flow-start-editor";

/**
 * The Flows tab's inspector. With a step selected: the step's settings form, generated from the
 * step catalogue with one typed control per setting, and the step's place in the flow (move,
 * remove, add a step after it, add a branch). With the Start node (or nothing) selected: how the
 * flow starts. Every change is one flow command, judged by the flow commands and taken by the draft
 * as it is made; the draft saves it by itself.
 */

/**
 * Runs one flow command on the draft. `merge` makes consecutive edits with the same key one Undo
 * step; an applied result carries the source the draft holds afterwards.
 */
type StudioFlowRun = (expected: StudioFlowContext, selection: StudioFlowSelection, command: StudioFlowCommand,
  merge?: string) => StudioFlowEditResult;

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

export function StudioFlowInspector({ context, selection, lists, stepPath, ownerNote, choices, start, controlLabel, disabled,
  onCommand, onStart, onSelectStep }: Readonly<{
  context: StudioFlowContext;
  selection: StudioFlowSelection;
  lists: readonly StudioFlowTaskListOutline[];
  stepPath: StudioFlowPath | null;
  /** Who owns the flow when it is not the application itself. */
  ownerNote: string | undefined;
  /** What a step setting can point at in the draft. */
  choices: StudioFlowDraftChoices;
  start: StudioFlowStartProjection;
  controlLabel: (alias: string) => string;
  disabled: boolean;
  onCommand: StudioFlowRun;
  onStart: (expected: StudioFlowContext, draft: StudioFlowStartDraft, merge?: string) => StudioFlowEditResult;
  onSelectStep: (path: StudioFlowPath | null) => void;
}>) {
  const [confirm, confirmDialog] = useConfirm();
  const step = stepPath === null ? undefined : findStep(lists, stepPath);
  const actions = useMemo(() => projectStudioFlowStepActions(context, selection, step?.path ?? null), [context, selection, step?.path]);
  const outline = useMemo(() => {
    try { return studioFlowOutline(context, selection); }
    catch (cause) { console.error("[studio] the flow could not be read for its inspector", describeFailure(cause)); return null; }
  }, [context, selection]);
  const task = step === undefined ? undefined : outline?.entries.find((entry) => samePath(entry.path, step.path))?.task;
  const form = useMemo(() => task === undefined || step === undefined || outline === null ? null
    : projectStudioFlowStepForm(context.source, outline.flow, outline.siblings, selection.moduleKey, task, step.path, choices),
  [context.source, outline, selection.moduleKey, task, step, choices]);
  const references = useMemo(() => outline === null || step === undefined ? []
    : studioFlowReferenceChoices(context.source, outline.flow, outline.siblings, selection.moduleKey, step.path),
  [context.source, outline, selection.moduleKey, step]);
  const condition = useMemo(() => studioFlowConditionContext(references), [references]);
  /**
   * The settings as typed, on the draft snapshot they stand on: what the draft took (which it may
   * hold trimmed, so the typing is shown as typed), or input it refused, shown with its problem and
   * kept out of the draft. A change from elsewhere (Undo, Redo, a reload) drops it.
   */
  const [edits, setEdits] = useState<Readonly<{ base: unknown; draft: StudioFlowStepDraft; problem: string | null }> | null>(null);
  if (edits !== null && edits.base !== context.source) setEdits(null);
  const local = edits !== null && edits.base === context.source ? edits : null;
  const [problem, setProblem] = useState("");
  const [status, setStatus] = useState("");
  const [focusId, setFocusId] = useState<string | null>(null);

  useEffect(() => {
    if (form?.kind === "unavailable") console.error("[studio] flow step refused", { flow: selection.flowAlias, step: step?.id }, form.reason);
  }, [form, selection.flowAlias, step?.id]);

  // A step just added is selected once the draft has re-projected with it.
  useEffect(() => {
    if (focusId === null) return;
    const added = findStudioFlowStepById(lists, focusId);
    if (added !== undefined) { onSelectStep(added.path); setFocusId(null); }
  }, [focusId, lists, onSelectStep]);

  // A move, a removal or an added step: one explicit command. Settings being typed stay as typed on the new snapshot.
  const run = (command: StudioFlowCommand, done: string): StudioFlowEditResult => {
    const result = onCommand(context, selection, command);
    if (result.kind === "applied") {
      setProblem(""); setStatus(done);
      if (local !== null) setEdits({ ...local, base: result.source });
    } else { setStatus(""); setProblem(result.reason); }
    return result;
  };
  const add = (command: Extract<StudioFlowCommand, { kind: "insert_task" | "add_branch" }>, done: string) => {
    const result = run(command, done);
    if (result.kind === "applied") setFocusId(result.taskId);
  };

  const messages = <>
    {problem === "" ? null : <p role="alert" className="text-sm text-destructive">{problem}</p>}
    <p role="status" className="text-sm">{status}</p>
  </>;

  if (step === undefined) {
    const main = lists[0];
    return <div className="space-y-4">
      <StudioFlowStartEditor key={selection.flowAlias} projection={start}
        recordTypes={selection.moduleKey === null ? choices.recordTypes
          // A module's own flow names its own record types by their bare key, as its triggers do.
          : choices.recordTypes.filter((entry) => entry.key.startsWith(`${selection.moduleKey}:`))
            .map((entry) => ({ key: entry.key.slice(entry.key.indexOf(":") + 1), label: entry.label }))}
        controlLabel={controlLabel} disabled={disabled}
        onApply={(draft, setting) => {
          const result = onStart(context, draft,
            setting === undefined ? undefined : `flow-start:${selection.moduleKey ?? ""}:${selection.flowAlias}:${setting}`);
          return result.kind === "applied" ? true : result.reason;
        }} />
      {ownerNote === undefined ? null : <p className="text-sm text-muted-foreground">{ownerNote}</p>}
      <p className="text-sm text-muted-foreground">Select a step on the canvas to change its settings, move it or add a step after it.</p>
      {main !== undefined && <StepTypePicker id="flow-add-last" label="Add a step at the end" types={actions.stepTypes} disabled={disabled}
        action="Add" onAdd={(taskType) => add({ kind: "insert_task", taskType, listPath: main.path, index: main.tasks.length }, "Step added at the end.")} />}
      {messages}
      {confirmDialog}
    </div>;
  }

  const index = step.path[step.path.length - 1] as number;
  const listPath = step.path.slice(0, -1);
  const draft = local?.draft ?? (form?.kind === "available" ? form.draft : null);
  // Each change goes to the draft at once; typing into one setting is one Undo step.
  const change = (next: StudioFlowStepDraft, blocked: string | null, setting: string) => {
    setStatus("");
    if (blocked !== null) { setEdits({ base: context.source, draft: next, problem: blocked }); return; }
    const result = onCommand(context, selection, { kind: "set_step", taskId: step.id, taskPath: step.path, draft: next },
      `flow-step:${selection.moduleKey ?? ""}:${selection.flowAlias}:${step.id}:${setting}`);
    if (result.kind === "applied") { setProblem(""); setEdits({ base: result.source, draft: next, problem: null }); }
    else setEdits({ base: context.source, draft: next, problem: result.reason });
  };
  const fields = form?.kind !== "available" || task === undefined || outline === null || draft === null ? []
    : refreshStudioFlowStepFields(context.source, outline.flow, selection.moduleKey, task, draft, choices, form.fields);
  const siblings: readonly SourceFlow[] = (outline?.siblings ?? []).filter((flow) => flow.id !== selection.flowAlias);

  return <div className="space-y-4">
    <div className="space-y-1">
      <h3 className="text-sm font-medium">{step.title}</h3>
      <p className="text-sm text-muted-foreground">{step.caption}</p>
    </div>
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" size="sm" disabled={disabled || !actions.canMoveUp}
        onClick={() => { run({ kind: "move_task", taskId: step.id, taskPath: step.path, direction: "up" }, "Step moved up."); }}>Move up</Button>
      <Button type="button" variant="outline" size="sm" disabled={disabled || !actions.canMoveDown}
        onClick={() => { run({ kind: "move_task", taskId: step.id, taskPath: step.path, direction: "down" }, "Step moved down."); }}>Move down</Button>
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => {
        void (async () => {
          if (!await confirm({ title: `Remove ${step.title}?`, confirmLabel: "Remove step",
            description: step.children.some((child) => child.tasks.length > 0)
              ? "This step and the steps in its branches are removed from the flow. Undo restores them."
              : "This step is removed from the flow. Undo restores it." })) return;
          if (run({ kind: "remove_task", taskId: step.id, taskPath: step.path }, "Step removed.").kind === "applied") onSelectStep(null);
        })();
      }}>Remove</Button>
    </div>
    <section className="space-y-3" aria-label="Step settings">
      <h4 className="text-sm font-medium">Settings</h4>
      {form === null && <p role="alert" className="text-sm">The settings of this step could not be read from the draft.</p>}
      {form?.kind === "unavailable" && <p role="alert" className="text-sm text-destructive">{form.reason}</p>}
      {form?.kind === "available" && draft !== null && <>
        <StudioFlowStepForm id={`flow-step-${step.id}`} fields={fields} draft={draft} controlEntries={form.controlEntries}
          calculationReferences={form.calculationReferences} references={references} condition={condition} choices={choices}
          flows={siblings} disabled={disabled} onChange={change} />
        {local?.problem == null ? null : <p role="alert" className="text-sm text-destructive">
          {local.problem} The step keeps its last valid settings until this is fixed.</p>}
      </>}
    </section>
    <section className="space-y-3" aria-label="Add steps">
      <StepTypePicker id="flow-add-after" label="Add a step after this one" types={actions.stepTypes} disabled={disabled}
        action="Add" onAdd={(taskType) => add({ kind: "insert_task", taskType, listPath, index: index + 1 }, "Step added.")} />
      {step.children.map((child) => <StepTypePicker key={JSON.stringify(child.path)} id={`flow-add-in-${JSON.stringify(child.path)}`}
        label={`Add a step to ${child.label}`} types={actions.stepTypes} disabled={disabled} action="Add"
        onAdd={(taskType) => add({ kind: "insert_task", taskType, listPath: child.path, index: child.tasks.length }, `Step added to ${child.label}.`)} />)}
      {actions.branch !== null && <StepTypePicker id="flow-add-branch" label={`Add the ${actions.branch} branch, starting with`}
        types={actions.stepTypes} disabled={disabled} action="Add branch"
        onAdd={(taskType) => add({ kind: "add_branch", taskId: step.id, taskPath: step.path, taskType }, `${actions.branch} branch added.`)} />}
    </section>
    {messages}
    {confirmDialog}
  </div>;
}
