"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { StudioSemanticSelection } from "@vortex/studio";
import {
  projectStudioFlowTextEditor,
  projectStudioFlowPresentationPalette,
  type StudioFlowTaskListOutline,
  type StudioFlowTaskOutline,
  type StudioFlowTextCommand,
  type StudioFlowTextContext,
  type StudioFlowTextResult,
  type StudioFlowPresentationCommand,
  type StudioFlowPresentationTaskType,
} from "@vortex/studio";

type FlowSelection = Extract<StudioSemanticSelection, { kind: "flow" }>;
type Target = Readonly<{ id: string; path: readonly (string | number)[]; property: string }>;
type Buffer = Readonly<{
  context: StudioFlowTextContext;
  selection: FlowSelection;
  target: Target;
  initial: string;
  text: string;
}>;
type InsertInputs = Readonly<{
  taskType: StudioFlowPresentationTaskType | "";
  taskId: string;
  message: string;
  supplyTitle: boolean;
  title: string;
}>;
type InsertBuffer = Readonly<{
  context: StudioFlowTextContext;
  selection: FlowSelection;
  inputs: InsertInputs;
}>;
const emptyInsertInputs: InsertInputs = {
  taskType: "", taskId: "", message: "", supplyTitle: false, title: "",
};
type Props = Readonly<{
  context: StudioFlowTextContext;
  selection: FlowSelection;
  disabled: boolean;
  onPendingChange: (pending: boolean) => void;
  onAppendPendingChange: (pending: boolean) => void;
  onCommand: (expected: StudioFlowTextContext, selection: FlowSelection,
    command: StudioFlowTextCommand) => StudioFlowTextResult["kind"];
  onAppend: (expected: StudioFlowTextContext, selection: FlowSelection,
    command: StudioFlowPresentationCommand) => StudioFlowTextResult["kind"];
}>;

const buttonClass = "rounded border border-border px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50";
const inputClass = "w-full rounded border border-border bg-background px-3 py-2 text-foreground";
const pathKey = (path: readonly (string | number)[]) => JSON.stringify(path);

function TaskList({ list, selected, disabled, choose }: {
  list: StudioFlowTaskListOutline;
  selected: Target | null;
  disabled: boolean;
  choose: (task: StudioFlowTaskOutline) => void;
}) {
  return <section className="space-y-2">
    <h4 className="font-medium">{list.label}</h4>
    {list.tasks.length === 0 ? <p className="text-sm text-muted-foreground">No tasks.</p>
      : <ol className="space-y-2 border-l border-border pl-3">
        {list.tasks.map((task) => <li key={pathKey(task.path)} className="space-y-2">
          <button type="button" className={`${buttonClass} w-full text-left`} disabled={disabled}
            aria-pressed={selected?.id === task.id && pathKey(selected.path) === pathKey(task.path)}
            onClick={() => choose(task)}>
            {task.title} <span className="text-xs text-muted-foreground">({task.id})</span>
          </button>
          {task.properties.length === 0 && <p className="text-sm text-muted-foreground">Configuration is read-only here.</p>}
          {task.children.map((child) => <TaskList key={pathKey(child.path)} list={child}
            selected={selected} disabled={disabled} choose={choose} />)}
        </li>)}
      </ol>}
  </section>;
}

const findTask = (lists: readonly StudioFlowTaskListOutline[], target: Target | null):
  StudioFlowTaskOutline | undefined => {
  if (target === null) return undefined;
  for (const list of lists) for (const task of list.tasks) {
    if (task.id === target.id && pathKey(task.path) === pathKey(target.path)) return task;
    const child = findTask(task.children, target);
    if (child !== undefined) return child;
  }
  return undefined;
};

/** A consumed task list, not an alternate execution graph or a free source editor. */
export function ApplicationFlowEditor({ context, selection, disabled, onPendingChange,
  onAppendPendingChange, onCommand, onAppend }: Props) {
  const projection = useMemo(() => projectStudioFlowTextEditor(context, selection), [context, selection]);
  const palette = useMemo(() => projectStudioFlowPresentationPalette(context, selection), [context, selection]);
  const [target, setTarget] = useState<Target | null>(null);
  const [buffer, setBuffer] = useState<Buffer | null>(null);
  const currentBuffer = useRef<Buffer | null>(null);
  const [insertInputs, setInsertInputs] = useState(emptyInsertInputs);
  const currentInsert = useRef<InsertBuffer | null>(null);
  const [pendingInsert, setPendingInsert] = useState(false);
  const active = useRef(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; onPendingChange(false); onAppendPendingChange(false); };
  }, [onPendingChange, onAppendPendingChange]);
  const lists = projection.kind === "available" ? projection.lists : [];
  const task = findTask(lists, target);
  const property = task?.properties.find((item) => item.key === target?.property);
  const pending = buffer !== null && buffer.text !== buffer.initial;

  const discard = () => {
    currentBuffer.current = null;
    setBuffer(null);
    onPendingChange(false);
    setMessage("");
  };
  const discardInsert = () => {
    currentInsert.current = null;
    setInsertInputs(emptyInsertInputs);
    setPendingInsert(false);
    onAppendPendingChange(false);
    setMessage("");
  };
  const canChangeTarget = (): boolean => active.current && !disabled &&
    ((currentBuffer.current === null && currentInsert.current === null) ||
      window.confirm("Discard unapplied Flow text and insertion inputs and change the selected task or property?"));
  const chooseTask = (next: StudioFlowTaskOutline) => {
    if (!canChangeTarget()) return;
    discard();
    discardInsert();
    setTarget({ id: next.id, path: next.path, property: next.properties[0]?.key ?? "" });
  };
  const changeText = (text: string) => {
    if (!active.current || disabled || currentInsert.current !== null || target === null || property === undefined) return;
    const previous = currentBuffer.current;
    const next: Buffer = previous === null
      ? { context, selection, target, initial: property.value, text }
      : { ...previous, text };
    const retained = next.text === next.initial ? null : next;
    currentBuffer.current = retained;
    // Report synchronously, before React renders, so other workspace callbacks cannot miss it.
    onPendingChange(retained !== null);
    setBuffer(retained);
    setMessage("");
  };
  const apply = () => {
    const expected = currentBuffer.current;
    if (!active.current || disabled || currentInsert.current !== null || expected === null || expected.text === expected.initial) return;
    const result = onCommand(expected.context, expected.selection, {
      taskId: expected.target.id, taskPath: expected.target.path,
      property: expected.target.property, text: expected.text,
    });
    if (result === "applied") {
      discard();
      setMessage("Flow text applied to local history. Save draft to persist it.");
    } else setMessage(result === "stale"
      ? "This task or draft changed. Your text is preserved; discard it and select the current task to continue."
      : result === "unsupported" ? "This property is read-only. Your text is preserved."
        : result === "no_change" ? "The source already has this text. No history change was made."
          : "Use non-empty text of at most 2000 characters without template delimiters. Your text is preserved.");
  };
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); apply(); };
  const changeInsert = (patch: Partial<InsertInputs>) => {
    if (!active.current || disabled || currentBuffer.current !== null) return;
    const previous = currentInsert.current;
    const inputs = { ...(previous?.inputs ?? insertInputs), ...patch };
    const meaningful = inputs.taskType !== "" || inputs.taskId !== "" || inputs.message !== "" ||
      inputs.supplyTitle || inputs.title !== "";
    currentInsert.current = meaningful ? {
      context: previous?.context ?? context, selection: previous?.selection ?? selection, inputs,
    } : null;
    onAppendPendingChange(meaningful);
    setPendingInsert(meaningful);
    setInsertInputs(inputs);
    setMessage("");
  };
  const append = () => {
    const expected = currentInsert.current;
    if (!active.current || disabled || currentBuffer.current !== null || expected === null ||
      expected.inputs.taskType === "") return;
    const inputs = expected.inputs;
    const command: StudioFlowPresentationCommand = inputs.taskType === "interface.confirm"
      ? { kind: "append_presentation", taskType: inputs.taskType, taskId: inputs.taskId,
          message: inputs.message, ...(inputs.supplyTitle ? { title: inputs.title } : {}) }
      : { kind: "append_presentation", taskType: "interface.show_message", taskId: inputs.taskId, message: inputs.message };
    const result = onAppend(expected.context, expected.selection, command);
    if (result === "applied") {
      discardInsert();
      setMessage("Presentation task appended to local history. Save draft to persist it.");
    } else setMessage(result === "stale"
      ? "This Flow or draft changed. Your insertion inputs are preserved; discard them to use the current source."
      : result === "unsupported" ? "This Flow or task is not available for insertion. Your inputs are preserved."
        : "Use a unique lowercase task key of at most 40 characters and non-empty text of at most 2000 characters without template delimiters. The Flow must remain within its task limits. Your inputs are preserved.");
  };
  const submitAppend = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); append(); };

  return <section className="space-y-4" aria-label="Flow task editor">
    <p className="text-sm">Tasks retain their authored order and branches. Edit supported presentation text or append a registered presentation task to the main task list.</p>
    {palette.length > 0 ? <form className="space-y-3 rounded border border-border p-3" onSubmit={submitAppend}>
      <h3 className="font-semibold">Add presentation task</h3>
      <fieldset className="space-y-3" disabled={disabled || pending}>
        <label className="block space-y-1"><span>Task type</span>
          <select className={inputClass} required value={insertInputs.taskType} onChange={(event) => {
            const next = palette.find((entry) => entry.type === event.target.value);
            if (next !== undefined) changeInsert({ taskType: next.type });
          }}>
            <option value="" disabled>Choose a task</option>
            {palette.map((entry) => <option key={entry.type} value={entry.type}>{entry.title}</option>)}
          </select></label>
        <label className="block space-y-1"><span>Task key</span>
          <input className={inputClass} required maxLength={40} value={insertInputs.taskId}
            onChange={(event) => changeInsert({ taskId: event.target.value })} />
          <span className="block text-sm text-muted-foreground">Use a unique lowercase key, with words separated by underscores.</span></label>
        <label className="block space-y-1"><span>Message</span>
          <textarea className={inputClass} required maxLength={2000} value={insertInputs.message}
            onChange={(event) => changeInsert({ message: event.target.value })} onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault(); append();
              }
            }} /></label>
        {insertInputs.taskType === "interface.confirm" && <>
          <label className="flex gap-2"><input type="checkbox" checked={insertInputs.supplyTitle}
            onChange={(event) => changeInsert({ supplyTitle: event.target.checked })} />Supply a title</label>
          {insertInputs.supplyTitle && <label className="block space-y-1"><span>Title</span>
            <input className={inputClass} required maxLength={2000} value={insertInputs.title}
              onChange={(event) => changeInsert({ title: event.target.value })} /></label>}
        </>}
        <p className="text-sm">Append adds one task to the end of Tasks. It does not run the Flow. Enter applies; Shift+Enter adds a message line.</p>
        <button className={buttonClass} type="submit" disabled={!pendingInsert}>Append task</button>
      </fieldset>
      <button className={buttonClass} type="button" disabled={disabled || !pendingInsert} onClick={discardInsert}>Discard insertion inputs</button>
    </form> : <p className="text-sm">No presentation task can be appended to this Flow under its current execution kind, registry or task limits.</p>}
    {palette.length === 0 && pendingInsert && <button type="button" className={buttonClass}
      disabled={disabled} onClick={discardInsert}>Discard preserved insertion inputs</button>}
    {projection.kind !== "available" ? <p role="status">This Flow outline is unavailable or ambiguous. No source is changed.</p>
      : lists.map((list) => <TaskList key={pathKey(list.path)} list={list} selected={target}
        disabled={disabled} choose={chooseTask} />)}
    {task !== undefined && <section className="space-y-3 rounded border border-border p-3" aria-label="Task text inspector">
      <h3 className="font-semibold">{task.title}</h3>
      {task.properties.length === 0 ? <p>This task's configuration is read-only in this editor.</p>
        : <form onSubmit={submit} className="space-y-3">
          <label className="block space-y-1"><span>Presentation property</span>
            <select className={inputClass} value={target?.property ?? ""} disabled={disabled}
              onChange={(event) => {
                const next = task.properties.find((item) => item.key === event.target.value);
                if (next === undefined || !canChangeTarget()) return;
                discard();
                discardInsert();
                setTarget({ id: task.id, path: task.path, property: next.key });
              }}>
              {task.properties.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
            </select></label>
          {property !== undefined && <label className="block space-y-1"><span>{property.label}</span>
            <textarea className={inputClass} required maxLength={2000} disabled={disabled || pendingInsert}
              value={buffer?.text ?? property.value} onChange={(event) => changeText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault(); apply();
                }
              }} />
            <span className="block text-sm text-muted-foreground">Enter applies; Shift+Enter adds a line.</span>
          </label>}
          <div className="flex gap-2">
            <button className={buttonClass} type="submit" disabled={disabled || pendingInsert || !pending}>Apply text</button>
            <button className={buttonClass} type="button" disabled={disabled || !pending} onClick={discard}>Discard text</button>
          </div>
        </form>}
    </section>}
    {pending && <div className="space-y-2">
      <p className="text-sm">Apply or discard this text before saving, undoing or editing other items.</p>
      {(task === undefined || property === undefined) && <button type="button" className={buttonClass}
        disabled={disabled} onClick={discard}>Discard preserved text</button>}
    </div>}
    <p role="status" aria-live="polite">{message}</p>
  </section>;
}
