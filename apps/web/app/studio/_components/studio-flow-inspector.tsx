"use client";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@vortex/ui";

import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import { Button } from "@vortex/ui/components/button";
import { describeFailure, type SourceFlow } from "@vortex/platform/schema";
import {
  StudioField,
  StudioReferencePicker,
  StudioHelp,
  StudioInspectorGroup,
  StudioInspectorActions,
  StudioOptionControl,
  StudioFlowStepPicker,
  projectStudioFlowStepActions,
  projectStudioFlowStepForm,
  refreshStudioFlowStepFields,
  samePath,
  studioFlowConditionContext,
  studioFlowOutline,
  studioFlowReferenceChoices,
  studioFlowFieldOptions,
  type StudioFlowCommand,
  type StudioFlowCreateCommand,
  type StudioFlowContext,
  type StudioFlowDraftChoices,
  type StudioFlowEditResult,
  type StudioFlowPath,
  type StudioFlowSelection,
  type StudioFlowStartDraft,
  type StudioFlowStartProjection,
  type StudioFlowStepDraft,
  type StudioFlowTaskListOutline,
  type StudioFlowTaskOutline,
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
type StudioFlowRun = (
  expected: StudioFlowContext,
  selection: StudioFlowSelection,
  command: StudioFlowCommand,
  merge?: string,
) => StudioFlowEditResult;

const findStep = (
  lists: readonly StudioFlowTaskListOutline[],
  path: StudioFlowPath,
): StudioFlowTaskOutline | undefined => {
  for (const list of lists)
    for (const task of list.tasks) {
      if (samePath(task.path, path)) return task;
      const child = findStep(task.children, path);
      if (child !== undefined) return child;
    }
  return undefined;
};

const findStudioFlowStepById = (
  lists: readonly StudioFlowTaskListOutline[],
  id: string,
): StudioFlowTaskOutline | undefined => {
  for (const list of lists)
    for (const task of list.tasks) {
      if (task.id === id) return task;
      const child = findStudioFlowStepById(task.children, id);
      if (child !== undefined) return child;
    }
  return undefined;
};

/** Canvas and keyboard selection use the same step identities and selection callback. */
const stepChoices = (
  lists: readonly StudioFlowTaskListOutline[],
): readonly Readonly<{
  value: string;
  label: string;
  group: string;
  description: string;
}>[] =>
  lists.flatMap((list) =>
    list.tasks.flatMap((task) => [
      { value: task.id, label: task.title, group: list.label, description: task.caption },
      ...stepChoices(task.children),
    ]),
  );

export function StudioFlowInspector({
  context,
  selection,
  lists,
  stepPath,
  ownerNote,
  choices,
  start,
  controlLabel,
  disabled,
  onCommand,
  onStart,
  onSelectStep,
  onCreate,
}: Readonly<{
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
  onStart: (
    expected: StudioFlowContext,
    draft: StudioFlowStartDraft,
    merge?: string,
  ) => StudioFlowEditResult;
  onSelectStep: (path: StudioFlowPath | null) => void;
  onCreate: (command: StudioFlowCreateCommand, stayOnPlacement?: boolean) => string | true;
}>) {
  const [confirm, confirmDialog] = useConfirm();
  const step = stepPath === null ? undefined : findStep(lists, stepPath);
  const actions = useMemo(
    () => projectStudioFlowStepActions(context, selection, step?.path ?? null),
    [context, selection, step?.path],
  );
  const outline = useMemo(() => {
    try {
      return studioFlowOutline(context, selection);
    } catch (cause) {
      console.error(
        "[studio] the flow could not be read for its inspector",
        describeFailure(cause),
      );
      return null;
    }
  }, [context, selection]);
  const task =
    step === undefined
      ? undefined
      : outline?.entries.find((entry) => samePath(entry.path, step.path))?.task;
  const form = useMemo(
    () =>
      task === undefined || step === undefined || outline === null
        ? null
        : projectStudioFlowStepForm(
            context.source,
            outline.flow,
            outline.siblings,
            selection.moduleKey,
            task,
            step.path,
            choices,
          ),
    [context.source, outline, selection.moduleKey, task, step, choices],
  );
  const references = useMemo(
    () =>
      outline === null || step === undefined
        ? []
        : studioFlowReferenceChoices(
            context.source,
            outline.flow,
            outline.siblings,
            selection.moduleKey,
            step.path,
            choices.forms,
          ),
    [context.source, outline, selection.moduleKey, step, choices.forms],
  );
  const condition = useMemo(() => studioFlowConditionContext(references), [references]);
  /**
   * The settings as typed, on the draft snapshot they stand on: what the draft took (which it may
   * hold trimmed, so the typing is shown as typed), or input it refused, shown with its problem and
   * kept out of the draft. A change from elsewhere (Undo, Redo, a reload) drops it.
   */
  const [edits, setEdits] = useState<Readonly<{
    base: unknown;
    draft: StudioFlowStepDraft;
    problem: string | null;
  }> | null>(null);
  if (edits !== null && edits.base !== context.source) setEdits(null);
  const local = edits !== null && edits.base === context.source ? edits : null;
  const [problem, setProblem] = useState("");
  const [status, setStatus] = useState("");
  const [focusId, setFocusId] = useState<string | null>(null);
  const [saveRecordType, setSaveRecordType] = useState("");

  useEffect(() => {
    if (form?.kind === "unavailable")
      console.error(
        "[studio] flow step refused",
        { flow: selection.flowAlias, step: step?.id },
        form.reason,
      );
  }, [form, selection.flowAlias, step?.id]);

  // A step just added is selected once the draft has re-projected with it.
  useEffect(() => {
    if (focusId === null) return;
    const added = findStudioFlowStepById(lists, focusId);
    if (added !== undefined) {
      onSelectStep(added.path);
      setFocusId(null);
    }
  }, [focusId, lists, onSelectStep]);

  // A move, a removal or an added step: one explicit command. Settings being typed stay as typed on the new snapshot.
  const run = (command: StudioFlowCommand, done: string): StudioFlowEditResult => {
    const result = onCommand(context, selection, command);
    if (result.kind === "applied") {
      setProblem("");
      setStatus(done);
      if (local !== null) setEdits({ ...local, base: result.source });
    } else {
      setStatus("");
      setProblem(result.reason);
    }
    return result;
  };
  const pickerContext = (path: StudioFlowPath) => ({
    condition: studioFlowConditionContext(
      outline === null
        ? []
        : studioFlowReferenceChoices(
            context.source,
            outline.flow,
            outline.siblings,
            selection.moduleKey,
            path,
            choices.forms,
          ),
    ),
    fields:
      outline === null
        ? []
        : (studioFlowFieldOptions(context.source, outline.flow, selection.moduleKey, {}) ?? []),
  });
  const add = (
    command: Extract<StudioFlowCommand, { kind: "insert_task" | "add_branch" }>,
    done: string,
  ) => {
    const result = run(command, done);
    if (result.kind === "applied") setFocusId(result.taskId);
    return result.kind === "applied";
  };

  const stepPicker = (
    <StudioField label="Step">
      {(control) => (
        <StudioReferencePicker
          {...control}
          value={step?.id ?? ""}
          unset="Start"
          options={stepChoices(lists)}
          disabled={disabled}
          onChange={(id) => {
            if (id === "") onSelectStep(null);
            else {
              const chosen = findStudioFlowStepById(lists, id);
              if (chosen !== undefined) onSelectStep(chosen.path);
            }
          }}
        />
      )}
    </StudioField>
  );

  const messages = (
    <>
      {problem === "" ? null : (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      <p role="status" className="text-sm">
        {status}
      </p>
    </>
  );

  if (step === undefined) {
    const main = lists[0];
    return (
      <div className="space-y-4">
        {stepPicker}
        <StudioFlowStartEditor
          key={selection.flowAlias}
          projection={start}
          recordTypes={
            selection.moduleKey === null
              ? choices.recordTypes
              : // A module's own flow names its own record types by their bare key, as its triggers do.
                choices.recordTypes
                  .filter((entry) => entry.key.startsWith(`${selection.moduleKey}:`))
                  .map((entry) => ({
                    key: entry.key.slice(entry.key.indexOf(":") + 1),
                    label: entry.label,
                  }))
          }
          controlLabel={controlLabel}
          disabled={disabled}
          onApply={(draft, setting) => {
            const result = onStart(
              context,
              draft,
              setting === undefined
                ? undefined
                : `flow-start:${selection.moduleKey ?? ""}:${selection.flowAlias}:${setting}`,
            );
            return result.kind === "applied" ? true : result.reason;
          }}
        />
        {ownerNote === undefined ? null : <StudioHelp hint={ownerNote} />}
        <StudioHelp hint="Select a step on the canvas to change its settings, move it or add a step after it." />
        {main !== undefined && (
          <StudioFlowStepPicker
            context={pickerContext([...main.path, main.tasks.length])}
            id="flow-add-last"
            label="Add a step at the end"
            types={actions.stepTypes}
            disabled={disabled}
            action="Add"
            onAdd={(taskType, settings) =>
              add(
                {
                  kind: "insert_task",
                  taskType,
                  settings,
                  listPath: main.path,
                  index: main.tasks.length,
                },
                "Step added at the end.",
              )
            }
          />
        )}
        {messages}
        {confirmDialog}
      </div>
    );
  }

  const index = step.path[step.path.length - 1] as number;
  const listPath = step.path.slice(0, -1);
  const draft = local?.draft ?? (form?.kind === "available" ? form.draft : null);
  // Each change goes to the draft at once; typing into one setting is one Undo step.
  const change = (next: StudioFlowStepDraft, blocked: string | null, setting: string) => {
    setStatus("");
    if (blocked !== null) {
      setEdits({ base: context.source, draft: next, problem: blocked });
      return;
    }
    const result = onCommand(
      context,
      selection,
      { kind: "set_step", taskId: step.id, taskPath: step.path, draft: next },
      `flow-step:${selection.moduleKey ?? ""}:${selection.flowAlias}:${step.id}:${setting}`,
    );
    if (result.kind === "applied") {
      setProblem("");
      setEdits({ base: result.source, draft: next, problem: null });
    } else setEdits({ base: context.source, draft: next, problem: result.reason });
  };
  const fields =
    form?.kind !== "available" || task === undefined || outline === null || draft === null
      ? []
      : refreshStudioFlowStepFields(
          context.source,
          outline.flow,
          selection.moduleKey,
          task,
          draft,
          choices,
          form.fields,
        );
  const siblings: readonly SourceFlow[] = (outline?.siblings ?? []).filter(
    (flow) => flow.id !== selection.flowAlias,
  );

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Icon name="workflow" className="size-4 shrink-0" />
            {step.title}
          </h3>
          <p className="text-xs text-muted-foreground">Flow step</p>
        </div>
        <StudioInspectorActions
          actions={[
            {
              label: "Move up",
              disabled: disabled || !actions.canMoveUp,
              onSelect: () => {
                run(
                  { kind: "move_task", taskId: step.id, taskPath: step.path, direction: "up" },
                  "Step moved up.",
                );
              },
            },
            {
              label: "Move down",
              disabled: disabled || !actions.canMoveDown,
              onSelect: () => {
                run(
                  { kind: "move_task", taskId: step.id, taskPath: step.path, direction: "down" },
                  "Step moved down.",
                );
              },
            },
            {
              label: "Remove",
              destructive: true,
              disabled,
              onSelect: () => {
                void (async () => {
                  if (
                    !(await confirm({
                      title: `Remove ${step.title}?`,
                      confirmLabel: "Remove step",
                      destructive: true,
                      description: step.children.some((child) => child.tasks.length > 0)
                        ? "This step and the steps in its branches are removed from the flow. Undo restores them."
                        : "This step is removed from the flow. Undo restores it.",
                    }))
                  )
                    return;
                  if (
                    run(
                      { kind: "remove_task", taskId: step.id, taskPath: step.path },
                      "Step removed.",
                    ).kind === "applied"
                  )
                    onSelectStep(null);
                })();
              },
            },
          ]}
        />
      </div>
      {stepPicker}
      <StudioInspectorGroup title="Settings">
        {form === null && (
          <p role="alert" className="text-sm">
            The settings of this step could not be read from the draft.
          </p>
        )}
        {form?.kind === "unavailable" && (
          <p role="alert" className="text-sm text-destructive">
            {form.reason}
          </p>
        )}
        {form?.kind === "available" && draft !== null && (
          <>
            <StudioFlowStepForm
              id={`flow-step-${step.id}`}
              fields={fields}
              draft={draft}
              controlEntries={form.controlEntries}
              references={references}
              condition={condition}
              choices={choices}
              flows={siblings}
              disabled={disabled}
              onChange={change}
            />
            {outline?.flow.execution === "interactive" &&
              task?.type === "data.calculate" &&
              "properties" in task &&
              task.properties.formula?.kind === "formula" && (
                <div className="space-y-2">
                  <StudioOptionControl
                    id={`flow-step-${step.id}-save-record`}
                    disabled={disabled}
                    value={saveRecordType}
                    options={[
                      { value: "", label: "Choose a record type" },
                      ...choices.recordTypes.map((record) => ({
                        value: record.key,
                        label: record.label,
                      })),
                    ]}
                    onChange={setSaveRecordType}
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={disabled || saveRecordType === "" || local?.problem != null}
                    onClick={() => {
                      const formula = task.properties.formula;
                      if (formula?.kind !== "formula") return;
                      const separator = saveRecordType.lastIndexOf(":");
                      const result = onCreate(
                        {
                          kind: "before_save",
                          moduleKey: saveRecordType.slice(0, separator),
                          recordTypeKey: saveRecordType.slice(separator + 1),
                          name: `${outline.flow.labels.name ?? outline.flow.key} save rule`,
                          message: "This record does not meet the required condition.",
                          operations: ["create", "update"],
                          condition: formula.formula,
                        },
                        true,
                      );
                      if (result === true) {
                        setProblem("");
                        setStatus("Save rule added.");
                      } else {
                        setStatus("");
                        setProblem(result);
                      }
                    }}
                  >
                    Also enforce on save
                  </Button>
                </div>
              )}
            {local?.problem == null ? null : (
              <p role="alert" className="text-sm text-destructive">
                {local.problem} The step keeps its last valid settings until this is fixed.
              </p>
            )}
          </>
        )}
      </StudioInspectorGroup>
      <StudioInspectorGroup title="Add steps">
        <StudioFlowStepPicker
          context={pickerContext([...listPath, index + 1])}
          id="flow-add-after"
          label="Add a step after this one"
          types={actions.stepTypes}
          disabled={disabled}
          action="Add"
          onAdd={(taskType, settings) =>
            add(
              {
                kind: "insert_task",
                taskType,
                settings,
                listPath,
                index: index + 1,
              },
              "Step added.",
            )
          }
        />
        {step.children.map((child) => (
          <StudioFlowStepPicker
            key={JSON.stringify(child.path)}
            context={pickerContext([...child.path, child.tasks.length])}
            id={`flow-add-in-${JSON.stringify(child.path)}`}
            label={`Add a step to ${child.label}`}
            types={actions.stepTypes}
            disabled={disabled}
            action="Add"
            onAdd={(taskType, settings) =>
              add(
                {
                  kind: "insert_task",
                  taskType,
                  settings,
                  listPath: child.path,
                  index: child.tasks.length,
                },
                `Step added to ${child.label}.`,
              )
            }
          />
        ))}
        {actions.branch !== null && (
          <StudioFlowStepPicker
            context={pickerContext(step.path)}
            id="flow-add-branch"
            label={`Add the ${actions.branch} branch, starting with`}
            types={actions.stepTypes}
            disabled={disabled}
            action="Add branch"
            onAdd={(taskType, settings) =>
              add(
                {
                  kind: "add_branch",
                  taskId: step.id,
                  taskPath: step.path,
                  taskType,
                  settings,
                },
                `${actions.branch} branch added.`,
              )
            }
          />
        )}
      </StudioInspectorGroup>
      {messages}
      {confirmDialog}
    </div>
  );
}
