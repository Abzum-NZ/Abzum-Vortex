"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { flowRoundingModeSchema } from "@vortex/contracts";
import type { StudioSemanticSelection } from "@vortex/studio";
import {
  projectStudioFlowTextEditor,
  projectStudioFlowPresentationPalette,
  projectStudioFlowPresentationMoves,
  projectStudioFlowPresentationRemoval,
  projectStudioFlowCalculateEditor,
  type StudioFlowTaskListOutline,
  type StudioFlowTaskOutline,
  type StudioFlowTextCommand,
  type StudioFlowTextContext,
  type StudioFlowTextResult,
  type StudioFlowPresentationCommand,
  type StudioFlowPresentationTaskType,
  type StudioFlowPresentationMoveCommand,
  type StudioFlowPresentationMoveOption,
  type StudioFlowPresentationRemovalCommand,
  type StudioFlowCalculateCommand,
  type StudioFlowCalculateOperand,
  type StudioFlowCalculateProjection,
  type StudioFlowCalculateSettings,
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
type OperandInputs = Readonly<{
  kind: "" | "whole_number" | "decimal_number" | "input" | "variable";
  value: string;
}>;
type CalculateInputs = Readonly<{
  taskId: string;
  operator: "" | StudioFlowCalculateSettings["operator"];
  left: OperandInputs;
  right: OperandInputs;
  scale: string;
  rounding: string;
}>;
type CalculateBuffer = Readonly<{
  context: StudioFlowTextContext;
  selection: FlowSelection;
  target: Target | null;
  inputs: CalculateInputs;
}>;
const operandInputs = (operand: StudioFlowCalculateOperand): OperandInputs =>
  operand.kind === "literal"
    ? { kind: operand.literal.type, value: String(operand.literal.value) }
    : { kind: operand.kind, value: operand.name };
const commandOperand = (inputs: OperandInputs): StudioFlowCalculateOperand | undefined => {
  if (inputs.kind === "whole_number") {
    if (!/^-?(?:0|[1-9]\d*)$/.test(inputs.value)) return undefined;
    const value = Number(inputs.value);
    return Number.isSafeInteger(value) ? { kind: "literal", literal: { type: "whole_number", value } } : undefined;
  }
  if (inputs.kind === "decimal_number")
    return { kind: "literal", literal: { type: "decimal_number", value: inputs.value } };
  if (inputs.kind === "input" || inputs.kind === "variable")
    return { kind: inputs.kind, name: inputs.value };
  return undefined;
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
  onMove: (expected: StudioFlowTextContext, selection: FlowSelection,
    command: StudioFlowPresentationMoveCommand, isCurrentTarget: () => boolean) => StudioFlowTextResult["kind"];
  onRemove: (expected: StudioFlowTextContext, selection: FlowSelection,
    command: StudioFlowPresentationRemovalCommand, isCurrentTarget: () => boolean) => StudioFlowTextResult["kind"];
  onCalculate: (expected: StudioFlowTextContext, selection: FlowSelection,
    command: StudioFlowCalculateCommand, isCurrentTarget: () => boolean) => StudioFlowTextResult["kind"];
}>;

const buttonClass = "rounded border border-border px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50";
const inputClass = "w-full rounded border border-border bg-background px-3 py-2 text-foreground";
const pathKey = (path: readonly (string | number)[]) => JSON.stringify(path);

function CalculateOperandFields({ label, inputs, references, change }: {
  label: string;
  inputs: OperandInputs;
  references: Extract<StudioFlowCalculateProjection, { kind: "available" }>["references"];
  change: (inputs: OperandInputs) => void;
}) {
  const options = references.filter((reference) => reference.kind === inputs.kind);
  return <fieldset className="space-y-2 rounded border border-border p-2">
    <legend>{label}</legend>
    <label className="block space-y-1"><span>Operand source</span>
      <select className={inputClass} required value={inputs.kind} onChange={(event) => {
        const kind = event.target.value;
        if (kind === "whole_number" || kind === "decimal_number" || kind === "input" || kind === "variable")
          change({ kind, value: "" });
      }}>
        <option value="" disabled>Choose an operand source</option>
        <option value="whole_number">Whole number</option>
        <option value="decimal_number">Decimal number</option>
        {references.some((entry) => entry.kind === "input") && <option value="input">Declared input</option>}
        {references.some((entry) => entry.kind === "variable") && <option value="variable">Initialized variable</option>}
      </select></label>
    {(inputs.kind === "whole_number" || inputs.kind === "decimal_number") &&
      <label className="block space-y-1"><span>Number</span>
        <input className={inputClass} required maxLength={120} inputMode="decimal" value={inputs.value}
          onChange={(event) => change({ ...inputs, value: event.target.value })} /></label>}
    {(inputs.kind === "input" || inputs.kind === "variable") &&
      <label className="block space-y-1"><span>Declared value</span>
        <select className={inputClass} required value={inputs.value} onChange={(event) => {
          const entry = options.find((option) => option.name === event.target.value);
          if (entry !== undefined) change({ ...inputs, value: entry.name });
        }}>
          <option value="" disabled>Choose a declared numeric value</option>
          {options.map((entry) => <option key={entry.name} value={entry.name}>{entry.name} ({entry.type})</option>)}
        </select></label>}
  </fieldset>;
}

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
          {task.properties.length === 0 && <p className="text-sm text-muted-foreground">
            {task.type === "data.calculate" ? "Select this task to check the supported Calculate controls."
              : "Configuration is read-only here."}</p>}
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
  onAppendPendingChange, onCommand, onAppend, onMove, onRemove, onCalculate }: Props) {
  const projection = useMemo(() => projectStudioFlowTextEditor(context, selection), [context, selection]);
  const palette = useMemo(() => projectStudioFlowPresentationPalette(context, selection), [context, selection]);
  const [target, setTarget] = useState<Target | null>(null);
  const currentTarget = useRef<Target | null>(null);
  const selectTarget = (next: Target | null) => { currentTarget.current = next; setTarget(next); };
  const [buffer, setBuffer] = useState<Buffer | null>(null);
  const currentBuffer = useRef<Buffer | null>(null);
  const [insertInputs, setInsertInputs] = useState(emptyInsertInputs);
  const currentInsert = useRef<InsertBuffer | null>(null);
  const [pendingInsert, setPendingInsert] = useState(false);
  const [calculateBuffer, setCalculateBuffer] = useState<CalculateBuffer | null>(null);
  const currentCalculate = useRef<CalculateBuffer | null>(null);
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
  const moves = useMemo(() => target === null ? []
    : projectStudioFlowPresentationMoves(context, selection, target.id, target.path), [context, selection, target]);
  const canRemove = useMemo(() => target !== null &&
    projectStudioFlowPresentationRemoval(context, selection, target.id, target.path), [context, selection, target]);
  const calculate = useMemo(() => projectStudioFlowCalculateEditor(context, selection, target?.id, target?.path),
    [context, selection, target]);
  const pendingCalculate = calculateBuffer !== null;

  const discard = () => {
    currentBuffer.current = null;
    setBuffer(null);
    onPendingChange(currentCalculate.current !== null);
    setMessage("");
  };
  const discardInsert = () => {
    currentInsert.current = null;
    setInsertInputs(emptyInsertInputs);
    setPendingInsert(false);
    onAppendPendingChange(false);
    setMessage("");
  };
  const discardCalculate = () => {
    currentCalculate.current = null;
    setCalculateBuffer(null);
    onPendingChange(currentBuffer.current !== null);
    setMessage("");
  };
  const canChangeTarget = (): boolean => active.current && !disabled &&
    ((currentBuffer.current === null && currentInsert.current === null && currentCalculate.current === null) ||
      window.confirm("Discard unapplied Flow text, Calculate and insertion inputs and change the selected task or property?"));
  const chooseTask = (next: StudioFlowTaskOutline) => {
    if (!canChangeTarget()) return;
    discard();
    discardInsert();
    discardCalculate();
    selectTarget({ id: next.id, path: next.path, property: next.properties[0]?.key ?? "" });
  };
  const changeText = (text: string) => {
    if (!active.current || disabled || currentInsert.current !== null || currentCalculate.current !== null || target === null || property === undefined) return;
    const previous = currentBuffer.current;
    const next: Buffer = previous === null
      ? { context, selection, target, initial: property.value, text }
      : { ...previous, text };
    const retained = next.text === next.initial ? null : next;
    currentBuffer.current = retained;
    // Report synchronously, before React renders, so other workspace callbacks cannot miss it.
    onPendingChange(retained !== null || currentCalculate.current !== null);
    setBuffer(retained);
    setMessage("");
  };
  const apply = () => {
    const expected = currentBuffer.current;
    if (!active.current || disabled || currentInsert.current !== null || currentCalculate.current !== null || expected === null || expected.text === expected.initial) return;
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
    if (!active.current || disabled || currentBuffer.current !== null || currentCalculate.current !== null) return;
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
    if (!active.current || disabled || currentBuffer.current !== null || currentCalculate.current !== null || expected === null ||
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
  const beginCalculate = (editing: boolean) => {
    if (calculate.kind !== "available" || (editing ? calculate.selected === null : !calculate.canAppend) ||
      !canChangeTarget() || !active.current || disabled) return;
    const selected = editing ? calculate.selected : null;
    if (editing && (selected === null || target === null)) return;
    discard();
    discardInsert();
    const inputs: CalculateInputs = selected === null
      ? { taskId: "", operator: "", left: { kind: "", value: "" }, right: { kind: "", value: "" }, scale: "", rounding: "" }
      : { taskId: selected.taskId, operator: selected.operator, left: operandInputs(selected.left),
          right: operandInputs(selected.right), scale: String(selected.scale), rounding: selected.rounding };
    const next: CalculateBuffer = { context, selection, target: editing ? target : null, inputs };
    currentCalculate.current = next;
    setCalculateBuffer(next);
    onPendingChange(true);
  };
  const changeCalculate = (patch: Partial<CalculateInputs>) => {
    const previous = currentCalculate.current;
    if (!active.current || disabled || previous === null || currentBuffer.current !== null || currentInsert.current !== null) return;
    const next = { ...previous, inputs: { ...previous.inputs, ...patch } };
    currentCalculate.current = next;
    setCalculateBuffer(next);
    onPendingChange(true);
    setMessage("");
  };
  const applyCalculate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const expected = currentCalculate.current;
    if (expected === null) return;
    const isCurrentTarget = (): boolean => {
      const actual = currentTarget.current;
      return active.current && !disabled && currentCalculate.current === expected &&
        currentBuffer.current === null && currentInsert.current === null &&
        (expected.target === null || (actual !== null && actual.id === expected.target.id &&
          pathKey(actual.path) === pathKey(expected.target.path)));
    };
    if (!isCurrentTarget()) return;
    const { inputs } = expected;
    const left = commandOperand(inputs.left);
    const right = commandOperand(inputs.right);
    const rounding = flowRoundingModeSchema.safeParse(inputs.rounding);
    if (inputs.operator === "" || left === undefined || right === undefined || !rounding.success ||
      !/^(?:0|[1-9]\d*)$/.test(inputs.scale)) {
      setMessage("Choose both numeric operands, an operator, precision and rounding. Your inputs are preserved.");
      return;
    }
    const settings: StudioFlowCalculateSettings = { operator: inputs.operator, left, right,
      scale: Number(inputs.scale), rounding: rounding.data };
    const command: StudioFlowCalculateCommand = expected.target === null
      ? { kind: "append_calculate", taskId: inputs.taskId, ...settings }
      : { kind: "edit_calculate", taskId: expected.target.id, taskPath: expected.target.path, ...settings };
    const result = onCalculate(expected.context, expected.selection, command, isCurrentTarget);
    if (result === "applied" || result === "no_change") {
      discardCalculate();
      setMessage(result === "applied" ? "Calculate applied to local history. Save draft to persist it."
        : "The source already has this calculation. No history change was made.");
    } else setMessage(result === "stale" ? "This task or draft changed. Your Calculate inputs are preserved; discard them to continue."
      : result === "unsupported" ? "This calculation is read-only here. Your inputs are preserved."
        : "Use valid numbers or current declared numeric values, a unique task key and precision from 0 to 18. Your inputs are preserved.");
  };
  const move = (option: StudioFlowPresentationMoveOption) => {
    const expectedTarget = target;
    if (expectedTarget === null) return;
    const isCurrentTarget = (): boolean => {
      const actual = currentTarget.current;
      return active.current && !disabled && currentBuffer.current === null && currentInsert.current === null && currentCalculate.current === null &&
        actual !== null && actual.id === expectedTarget.id && actual.property === expectedTarget.property &&
        pathKey(actual.path) === pathKey(expectedTarget.path) && actual.id === option.taskId &&
        pathKey(actual.path) === pathKey(option.taskPath);
    };
    if (!isCurrentTarget()) return;
    const result = onMove(context, selection, { kind: "move_presentation", ...option }, isCurrentTarget);
    if (result === "applied") {
      selectTarget({ ...expectedTarget, path: option.neighborPath });
      setMessage("Presentation task moved in local history. Save draft to persist it.");
    } else setMessage(result === "stale"
      ? "The selected task, adjacent task or draft changed. Select the current task to continue. Your inputs are preserved."
      : result === "unsupported" ? "These tasks cannot be moved across each other here. No source was changed."
        : result === "no_change" ? "This task is already at that boundary. No history entry was added."
          : "This task move could not be validated. No source was changed.");
  };

  const remove = () => {
    const expectedTarget = target;
    if (expectedTarget === null || !canRemove) return;
    const isCurrentTarget = (): boolean => {
      const actual = currentTarget.current;
      return active.current && !disabled && currentBuffer.current === null && currentInsert.current === null && currentCalculate.current === null &&
        actual !== null && actual.id === expectedTarget.id && actual.property === expectedTarget.property &&
        pathKey(actual.path) === pathKey(expectedTarget.path);
    };
    if (!isCurrentTarget() || !window.confirm("Remove this Show message task from the draft?")) return;
    if (!isCurrentTarget()) return;
    const result = onRemove(context, selection, {
      kind: "remove_presentation", taskId: expectedTarget.id, taskPath: expectedTarget.path,
    }, isCurrentTarget);
    if (result === "applied") {
      selectTarget(null);
      setMessage("Show message task removed from local history. Save draft to persist it.");
    } else setMessage(result === "stale"
      ? "The selected task or draft changed. Select the current task to continue. Your inputs are preserved."
      : "This task cannot be removed here. No source was changed.");
  };

  return <section className="space-y-4" aria-label="Flow task editor">
    <p className="text-sm">Inspect authored tasks and branches. Edit presentation text or a supported calculation, append a registered task, move adjacent compatible presentation tasks, or remove an unreferenced Show message task.</p>
    {palette.length > 0 ? <form className="space-y-3 rounded border border-border p-3" onSubmit={submitAppend}>
      <h3 className="font-semibold">Add presentation task</h3>
      <fieldset className="space-y-3" disabled={disabled || pending || pendingCalculate}>
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
    {calculate.kind === "available" && <section className="space-y-3 rounded border border-border p-3" aria-label="Calculate controls">
      <h3 className="font-semibold">Calculate</h3>
      <div className="flex gap-2">
        <button type="button" className={buttonClass} disabled={disabled || !calculate.canAppend}
          onClick={() => beginCalculate(false)}>Add Calculate task</button>
        {calculate.selected !== null && <button type="button" className={buttonClass} disabled={disabled}
          onClick={() => beginCalculate(true)}>Edit selected calculation</button>}
      </div>
      <p className="text-sm">Use two numeric operands with explicit precision and rounding. Other formulas remain read-only. These controls do not run the Flow.</p>
    </section>}
    {calculateBuffer !== null && <form className="space-y-3 rounded border border-border p-3" onSubmit={applyCalculate}>
      <h3 className="font-semibold">{calculateBuffer.target === null ? "Add calculation" : "Edit calculation"}</h3>
      <fieldset className="space-y-3" disabled={disabled || pending || pendingInsert || calculate.kind !== "available"}>
        {calculateBuffer.target === null ? <label className="block space-y-1"><span>Task key</span>
          <input className={inputClass} required maxLength={40} value={calculateBuffer.inputs.taskId}
            onChange={(event) => changeCalculate({ taskId: event.target.value })} />
          <span className="block text-sm">Use a unique lowercase key, with words separated by underscores.</span>
        </label> : <p>Task key: {calculateBuffer.target.id}</p>}
        <label className="block space-y-1"><span>Operator</span>
          <select className={inputClass} required value={calculateBuffer.inputs.operator} onChange={(event) => {
            const operator = event.target.value;
            if (operator === "add" || operator === "subtract" || operator === "multiply" || operator === "divide")
              changeCalculate({ operator });
          }}>
            <option value="" disabled>Choose an operator</option>
            <option value="add">Add</option><option value="subtract">Subtract</option>
            <option value="multiply">Multiply</option><option value="divide">Divide</option>
          </select></label>
        <CalculateOperandFields label="Left operand" inputs={calculateBuffer.inputs.left}
          references={calculate.kind === "available" ? calculate.references : []}
          change={(left) => changeCalculate({ left })} />
        <CalculateOperandFields label="Right operand" inputs={calculateBuffer.inputs.right}
          references={calculate.kind === "available" ? calculate.references : []}
          change={(right) => changeCalculate({ right })} />
        <label className="block space-y-1"><span>Decimal places</span>
          <input className={inputClass} type="number" required min={0} max={18} step={1}
            value={calculateBuffer.inputs.scale} onChange={(event) => changeCalculate({ scale: event.target.value })} />
        </label>
        <label className="block space-y-1"><span>Rounding</span>
          <select className={inputClass} required value={calculateBuffer.inputs.rounding}
            onChange={(event) => changeCalculate({ rounding: event.target.value })}>
            <option value="" disabled>Choose rounding</option>
            {flowRoundingModeSchema.options.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
          </select></label>
        <button type="submit" className={buttonClass}>Apply calculation</button>
      </fieldset>
      <p className="text-sm">Apply or discard these inputs before saving, undoing or editing other items. Stale inputs are preserved until you discard them.</p>
      <button type="button" className={buttonClass} disabled={disabled} onClick={discardCalculate}>Discard Calculate inputs</button>
    </form>}
    {projection.kind !== "available" ? <p role="status">This Flow outline is unavailable or ambiguous. No source is changed.</p>
      : lists.map((list) => <TaskList key={pathKey(list.path)} list={list} selected={target}
        disabled={disabled} choose={chooseTask} />)}
    {task !== undefined && <section className="space-y-3 rounded border border-border p-3" aria-label="Task text inspector">
      <h3 className="font-semibold">{task.title}</h3>
      {moves.length > 0 ? <div className="flex gap-2" aria-label="Presentation task order">
        {moves.map((option) => <button key={option.direction} type="button" className={buttonClass}
          disabled={disabled || pending || pendingInsert || pendingCalculate} onClick={() => move(option)}>
          {option.direction === "up" ? "Move up" : "Move down"}
        </button>)}
      </div> : <p className="text-sm">Move is available only across an adjacent compatible literal presentation task in Tasks.</p>}
      {canRemove ? <button type="button" className={buttonClass}
        disabled={disabled || pending || pendingInsert || pendingCalculate} onClick={remove}>Remove task</button>
        : <p className="text-sm">Remove is available only for an unreferenced literal Show message in Tasks, with another task remaining.</p>}
      {task.properties.length === 0 ? <p>{calculate.kind === "available" && calculate.selected !== null
        ? "Use the Calculate controls to edit this task's arithmetic formula."
        : "This task's configuration is read-only in this editor."}</p>
        : <form onSubmit={submit} className="space-y-3">
          <label className="block space-y-1"><span>Presentation property</span>
            <select className={inputClass} value={target?.property ?? ""} disabled={disabled}
              onChange={(event) => {
                const next = task.properties.find((item) => item.key === event.target.value);
                if (next === undefined || !canChangeTarget()) return;
                discard();
                discardInsert();
                discardCalculate();
                selectTarget({ id: task.id, path: task.path, property: next.key });
              }}>
              {task.properties.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
            </select></label>
          {property !== undefined && <label className="block space-y-1"><span>{property.label}</span>
            <textarea className={inputClass} required maxLength={2000} disabled={disabled || pendingInsert || pendingCalculate}
              value={buffer?.text ?? property.value} onChange={(event) => changeText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault(); apply();
                }
              }} />
            <span className="block text-sm text-muted-foreground">Enter applies; Shift+Enter adds a line.</span>
          </label>}
          <div className="flex gap-2">
            <button className={buttonClass} type="submit" disabled={disabled || pendingInsert || pendingCalculate || !pending}>Apply text</button>
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
