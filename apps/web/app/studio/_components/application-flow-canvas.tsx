"use client";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { Button } from "@vortex/ui/components/button";
import { NativeSelect } from "@vortex/ui/components/native-select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@vortex/ui/components/alert-dialog";
import { ApplicationFlowTaskSettings } from "./application-flow-task-settings";
import { describeFailure, type SourceFlow, type SourceFlowTask } from "@vortex/platform/schema";
import {
  projectStudioFlowInsertOptions,
  projectStudioFlowTextEditor,
  type StudioFlowEditResult,
  type StudioFlowInsertCommand,
  type StudioFlowRemoveCommand,
  type StudioFlowSettingCommand,
  type StudioFlowTaskListOutline,
  type StudioFlowTaskOutline,
  type StudioFlowTextContext,
  type StudioSemanticSelection,
} from "@vortex/ui/studio";

type FlowSelection = Extract<StudioSemanticSelection, { kind: "flow" }>;
type CanvasNodeData = Readonly<{ title: string; caption: string; kind: "trigger" | "task" | "group" }>;

const nodeWidth = 220;
const nodeHeight = 56;
const columnGap = 32;
const rowGap = 40;

// Errors and Finally are distinct transitions out of the main tasks; each names its own trigger.
const groupTransitions: Readonly<Record<string, Readonly<{ caption: string; edge: string }>>> = {
  Errors: { caption: "Runs when a task fails", edge: "on failure" },
  Finally: { caption: "Runs after the flow ends, however it ended", edge: "always" },
};

const pathKey = (path: readonly (string | number)[]) => JSON.stringify(path);

function CanvasNode({ data, selected }: NodeProps<Node<CanvasNodeData>>) {
  return <div
    className={`rounded-xl border bg-card text-card-foreground px-3 py-2 text-sm ${selected ? "border-ring ring-2 ring-ring" : "border-border"}`}
    style={{ width: nodeWidth, minHeight: nodeHeight }}>
    <Handle type="target" position={Position.Top} isConnectable={false} />
    <div className="font-medium truncate">{data.title}</div>
    <div className="text-xs text-muted-foreground truncate">{data.caption}</div>
    <Handle type="source" position={Position.Bottom} isConnectable={false} />
  </div>;
}
const nodeTypes = { canvas: CanvasNode };

const literalText = (value: unknown): string => {
  if (typeof value === "object" && value !== null && "value" in value) {
    const inner = (value as { value: unknown }).value;
    return typeof inner === "string" || typeof inner === "number" || typeof inner === "boolean" ? String(inner) : JSON.stringify(inner);
  }
  return JSON.stringify(value);
};

/** A switch case edge carries the value the case matches, not only its key. */
const branchLabel = (flow: SourceFlow, child: StudioFlowTaskListOutline): string => {
  const caseIndex = child.path.length >= 2 && child.path[child.path.length - 3] === "cases" ? child.path[child.path.length - 2] : undefined;
  if (caseIndex === undefined) return child.label;
  const owner = taskAt(flow, child.path.slice(0, -3));
  const when = owner !== undefined && "cases" in owner && Array.isArray(owner.cases) ? owner.cases[Number(caseIndex)]?.when : undefined;
  return when === undefined ? child.label : `${child.label} = ${literalText(when)}`;
};

type Layout = Readonly<{ width: number; height: number; firstIds: readonly string[]; lastIds: readonly string[] }>;

/** Computed positions only: lists run top to bottom, branches sit side by side below their task. */
function layoutList(flow: SourceFlow, list: StudioFlowTaskListOutline, left: number, top: number,
  nodes: Node<CanvasNodeData>[], edges: Edge[]): Layout {
  let y = top;
  let width = nodeWidth;
  let previous: readonly string[] = [];
  const firstIds: string[] = [];
  for (const task of list.tasks) {
    const id = pathKey(task.path);
    const nodeY = y;
    y += nodeHeight + rowGap;
    let branchX = left;
    let branchHeight = 0;
    const branches = task.children.map((child) => {
      const branch = layoutList(flow, child, branchX, y, nodes, edges);
      branchX += branch.width + columnGap;
      branchHeight = Math.max(branchHeight, branch.height);
      return { child, branch };
    });
    const span = Math.max(nodeWidth, branchX - columnGap - left);
    nodes.push({
      id, type: "canvas", draggable: false, connectable: false,
      position: { x: left + (span - nodeWidth) / 2, y: nodeY },
      data: { title: task.title, caption: task.id, kind: "task" },
    });
    for (const { child, branch } of branches) {
      for (const first of branch.firstIds)
        edges.push({ id: `${id}>${first}`, source: id, target: first, label: branchLabel(flow, child) });
    }
    if (previous.length > 0) {
      for (const from of previous) edges.push({ id: `${from}>${id}`, source: from, target: id });
    } else firstIds.push(id);
    // The next sibling follows where each branch ends; the branching task itself only falls
    // through when a branch is empty or absent (no else / no default).
    const ends = branches.flatMap(({ branch }) => branch.lastIds);
    const fallsThrough = branches.length === 0 || branches.some(({ branch }) => branch.lastIds.length === 0) ||
      (task.type === "if" && !task.children.some((child) => child.label === "Else")) ||
      (task.type === "switch" && !task.children.some((child) => child.label === "Default"));
    previous = fallsThrough ? [id, ...ends] : ends;
    width = Math.max(width, span);
    y += branchHeight > 0 ? branchHeight + rowGap : 0;
  }
  return { width, height: y - top, firstIds, lastIds: previous };
}

type Built = Readonly<{ nodes: Node<CanvasNodeData>[]; edges: Edge[] }>;

function buildGraph(flow: SourceFlow, lists: readonly StudioFlowTaskListOutline[]): Built {
  const nodes: Node<CanvasNodeData>[] = [];
  const edges: Edge[] = [];
  let left = 0;
  lists.forEach((list, index) => {
    if (list.tasks.length === 0) return;
    const hasHeader = index === 0 ? flow.triggers.length > 0 : true;
    const headerIds: string[] = [];
    let top = 0;
    if (index === 0) {
      flow.triggers.forEach((trigger, triggerIndex) => {
        const id = `trigger:${trigger.id}`;
        headerIds.push(id);
        nodes.push({
          id, type: "canvas", draggable: false, connectable: false,
          position: { x: left + triggerIndex * (nodeWidth + columnGap), y: 0 },
          data: { title: trigger.type, caption: trigger.id, kind: "trigger" },
        });
      });
    } else {
      const transition = groupTransitions[list.label];
      if (transition === undefined) console.error("Flow canvas has no transition for a task group", { group: list.label });
      const id = `group:${list.label}`;
      headerIds.push(id);
      nodes.push({
        id, type: "canvas", draggable: false, connectable: false, position: { x: left, y: 0 },
        data: { title: list.label, caption: transition?.caption ?? list.label, kind: "group" },
      });
    }
    if (hasHeader) top = nodeHeight + rowGap;
    const layout = layoutList(flow, list, left, top, nodes, edges);
    for (const header of headerIds) for (const first of layout.firstIds)
      edges.push({ id: `${header}>${first}`, source: header, target: first,
        ...(index === 0 ? {} : { label: groupTransitions[list.label]?.edge }) });
    left += Math.max(layout.width, headerIds.length * (nodeWidth + columnGap) - columnGap) + columnGap * 2;
  });
  return { nodes, edges };
}

const taskAt = (flow: SourceFlow, path: readonly (string | number)[]): SourceFlowTask | undefined => {
  let cursor: unknown = flow;
  for (const part of path) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string | number, unknown>)[part];
  }
  return typeof cursor === "object" && cursor !== null ? cursor as SourceFlowTask : undefined;
};

const findOutline = (lists: readonly StudioFlowTaskListOutline[], key: string): StudioFlowTaskOutline | undefined => {
  for (const list of lists) for (const task of list.tasks) {
    if (pathKey(task.path) === key) return task;
    const child = findOutline(task.children, key);
    if (child !== undefined) return child;
  }
  return undefined;
};

type FlowListChoice = Readonly<{ key: string; label: string; path: readonly (string | number)[]; length: number }>;

/** Every authored task list, including empty ones, named by the task that owns it. */
const flattenLists = (lists: readonly StudioFlowTaskListOutline[], prefix = ""): FlowListChoice[] =>
  lists.flatMap((list) => [
    { key: pathKey(list.path), label: `${prefix}${list.label}`, path: list.path, length: list.tasks.length },
    ...list.tasks.flatMap((task) => flattenLists(task.children, `${task.title} (${task.id}) › `)),
  ]);

const flattenTasks = (lists: readonly StudioFlowTaskListOutline[]): StudioFlowTaskOutline[] =>
  lists.flatMap((list) => list.tasks.flatMap((task) => [task, ...flattenTasks(task.children)]));

const countNested = (task: StudioFlowTaskOutline): number => flattenTasks(task.children).length;

/** An insertion stays bound to the draft snapshot and flow it was opened for, so a later switch cannot redirect it. */
type Adding = Readonly<{
  listPath: readonly (string | number)[]; index: number; where: string;
  expected: StudioFlowTextContext; expectedSelection: FlowSelection;
}>;

/** The draft flow's task list as a canvas; every edit goes through the draft's revision-checked history. */
export function ApplicationFlowCanvas({ context, selection, disabled, onInsert, onRemove, onSetting }: Readonly<{
  context: StudioFlowTextContext;
  selection: FlowSelection;
  disabled: boolean;
  onInsert: (expected: StudioFlowTextContext, selection: FlowSelection, command: StudioFlowInsertCommand) => StudioFlowEditResult;
  onRemove: (expected: StudioFlowTextContext, selection: FlowSelection, command: StudioFlowRemoveCommand) => StudioFlowEditResult;
  onSetting: (expected: StudioFlowTextContext, selection: FlowSelection, command: StudioFlowSettingCommand) => StudioFlowEditResult;
}>) {
  const projection = useMemo(() => projectStudioFlowTextEditor(context, selection), [context, selection]);
  const flow = useMemo(() => context.source.body.flows.find((entry) => entry.id === selection.flowAlias), [context, selection]);
  const graph = useMemo(() => projection.kind === "available" && flow !== undefined
    ? buildGraph(flow, projection.lists) : null, [projection, flow]);
  // A selection belongs to one flow and one task id, so it cannot leak across flow switches or edits.
  const [selected, setSelected] = useState<Readonly<{ flowAlias: string; key: string; id: string }> | null>(null);
  const [adding, setAdding] = useState<Adding | null>(null);
  // A removal asks first, bound to the task and draft snapshot it was opened for.
  const [removing, setRemoving] = useState<Readonly<{ expected: StudioFlowTextContext; expectedSelection: FlowSelection;
    taskId: string; taskPath: readonly (string | number)[]; nested: number }> | null>(null);
  const insertOptions = useMemo(() => projectStudioFlowInsertOptions(context, selection), [context, selection]);
  const options = insertOptions.kind === "available" ? insertOptions.options : [];
  const [taskType, setTaskType] = useState("");
  const [status, setStatus] = useState("");
  // A task just inserted is selected once the draft has re-projected with it.
  const [focusId, setFocusId] = useState<string | null>(null);

  useEffect(() => {
    if (projection.kind === "invalid")
      console.error("Flow canvas projection is unavailable", { flow: selection.flowAlias }, projection.cause);
    else if (flow === undefined)
      console.error("Flow canvas could not find the selected flow", { flow: selection.flowAlias });
  }, [projection, flow, selection.flowAlias]);

  useEffect(() => {
    if (insertOptions.kind === "invalid")
      console.error("Flow canvas task types are unavailable", { flow: selection.flowAlias }, describeFailure(insertOptions.cause));
  }, [insertOptions, selection.flowAlias]);

  // A pending add belongs to the flow it was opened for; switching flows discards it.
  useEffect(() => { setAdding((pending) => pending?.expectedSelection.flowAlias === selection.flowAlias ? pending : null); },
    [selection.flowAlias]);

  useEffect(() => {
    if (focusId === null || projection.kind !== "available") return;
    const hit = flattenTasks(projection.lists).find((task) => task.id === focusId);
    if (hit !== undefined) setSelected({ flowAlias: selection.flowAlias, key: pathKey(hit.path), id: hit.id });
    setFocusId(null);
  }, [focusId, projection, selection.flowAlias]);

  if (graph === null || projection.kind !== "available" || flow === undefined)
    return <p role="status">This Flow canvas is unavailable because the flow could not be read.</p>;

  const candidate = selected !== null && selected.flowAlias === selection.flowAlias
    ? findOutline(projection.lists, selected.key) : undefined;
  const selectedOutline = candidate !== undefined && candidate.id === selected?.id ? candidate : undefined;
  const selectedKey = selectedOutline === undefined ? null : selected?.key ?? null;
  const flowTask = selectedOutline === undefined ? undefined : taskAt(flow, selectedOutline.path);
  const listChoices = flattenLists(projection.lists);
  const themed = {
    "--xy-edge-stroke-default": "var(--border)",
    "--xy-edge-label-color-default": "var(--muted-foreground)",
    "--xy-edge-label-background-color-default": "var(--background)",
    "--xy-background-color-default": "var(--background)",
    "--xy-controls-button-background-color-default": "var(--card)",
    "--xy-controls-button-color-default": "var(--card-foreground)",
    "--xy-controls-button-border-color-default": "var(--border)",
  } as CSSProperties;

  const beginAdding = (next: Omit<Adding, "expected" | "expectedSelection">) => {
    setAdding({ ...next, expected: context, expectedSelection: selection });
    setTaskType("");
    setStatus("");
  };
  const addAfter = () => {
    if (selectedOutline === undefined) return;
    const index = selectedOutline.path[selectedOutline.path.length - 1];
    if (typeof index === "number")
      beginAdding({ listPath: selectedOutline.path.slice(0, -1), index: index + 1, where: `after ${selectedOutline.id}` });
  };
  const insert = () => {
    if (adding === null || taskType === "") return;
    const result = onInsert(adding.expected, adding.expectedSelection, { kind: "insert_task", taskType, listPath: adding.listPath, index: adding.index });
    if (result.kind === "applied") {
      setStatus(`Task ${result.taskId} added ${adding.where}. Save draft to persist it.`);
      setFocusId(result.taskId);
      setAdding(null);
    } else setStatus(result.reason);
  };
  const askRemove = () => {
    if (selectedOutline === undefined) return;
    setRemoving({ expected: context, expectedSelection: selection, taskId: selectedOutline.id,
      taskPath: selectedOutline.path, nested: countNested(selectedOutline) });
  };
  const remove = () => {
    if (removing === null) return;
    const result = onRemove(removing.expected, removing.expectedSelection,
      { kind: "remove_task", taskId: removing.taskId, taskPath: removing.taskPath });
    if (result.kind === "applied") {
      setStatus(`Task ${removing.taskId} removed. Save draft to persist it.`);
      setSelected(null);
    } else setStatus(result.reason);
    setRemoving(null);
  };

  return <section className="space-y-3" aria-label="Flow canvas">
    <h3 className="font-medium">Flow canvas</h3>
    <div className="h-96 rounded-xl border border-border" style={themed}>
      <ReactFlow nodes={graph.nodes.map((node) => ({ ...node, selected: node.id === selectedKey }))} edges={graph.edges}
        nodeTypes={nodeTypes} fitView nodesDraggable={false} nodesConnectable={false} edgesFocusable={false}
        elementsSelectable proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => {
          const outline = node.id.startsWith("[") ? findOutline(projection.lists, node.id) : undefined;
          setSelected(outline === undefined ? null : { flowAlias: selection.flowAlias, key: node.id, id: outline.id });
          setAdding(null);
        }}
        onPaneClick={() => setSelected(null)}>
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
    {selectedOutline === undefined
      ? <p className="text-sm text-muted-foreground">Select a task to see its settings, add a task after it or remove it.</p>
      : <div className="space-y-2 rounded-xl border border-border bg-card p-3 text-card-foreground">
        <h4 className="font-medium">{selectedOutline.title}</h4>
        <p className="text-sm"><span className="text-muted-foreground">Id:</span> {selectedOutline.id}
          {" "}<span className="text-muted-foreground">Type:</span> {selectedOutline.type}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={disabled || options.length === 0} onClick={addAfter}>Add task after</Button>
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={askRemove}>Remove task</Button>
        </div>
        {flowTask?.description !== undefined && <p className="text-sm"><span className="text-muted-foreground">Description:</span> {flowTask.description}</p>}
        <ApplicationFlowTaskSettings key={`${selection.flowAlias}:${selectedOutline.id}:${selectedKey}`} context={context}
          selection={selection} outline={selectedOutline} disabled={disabled} onSetting={onSetting} />
      </div>}
    <div className="space-y-2 rounded-xl border border-border bg-card p-3 text-card-foreground">
      <h4 className="font-medium">Add a task to a list or branch</h4>
      {insertOptions.kind === "invalid"
        ? <p role="alert" className="text-sm">{insertOptions.reason}</p>
        : options.length === 0
        ? <p className="text-sm text-muted-foreground">No task type can be added to this flow: its execution kind accepts none that can start from defaults, or it is at its task limit.</p>
        : <label className="block space-y-1 text-sm"><span>Task list</span>
          <NativeSelect className="w-full" disabled={disabled} value="" onChange={(event) => {
            const choice = listChoices.find((entry) => entry.key === event.target.value);
            if (choice !== undefined) beginAdding({ listPath: choice.path, index: choice.length, where: `in ${choice.label}` });
          }}>
            <option value="" disabled>Choose a list or branch</option>
            {listChoices.map((entry) => <option key={entry.key} value={entry.key}>{entry.label}{entry.length === 0 ? " (empty)" : ""}</option>)}
          </NativeSelect></label>}
    </div>
    {adding !== null && <form className="space-y-2 rounded-xl border border-border bg-card p-3 text-card-foreground"
      onSubmit={(event) => { event.preventDefault(); insert(); }}>
      <h4 className="font-medium">Add a task {adding.where}</h4>
      <label className="block space-y-1 text-sm"><span>Task type</span>
        <NativeSelect className="w-full" required disabled={disabled} value={taskType} onChange={(event) => setTaskType(event.target.value)}>
          <option value="" disabled>Choose a task type</option>
          {options.map((option) => <option key={option.type} value={option.type}>{option.title}</option>)}
        </NativeSelect></label>
      {taskType !== "" && <p className="text-sm text-muted-foreground">{options.find((option) => option.type === taskType)?.summary}</p>}
      <p className="text-sm text-muted-foreground">Only task types that this flow's execution kind accepts are listed. The task starts with default settings; edit its text in the Flow task editor.</p>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={disabled || taskType === ""}>Add task</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setAdding(null)}>Cancel</Button>
      </div>
    </form>}
    <AlertDialog open={removing !== null} onOpenChange={(open) => { if (!open) setRemoving(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove task {removing?.taskId}?</AlertDialogTitle>
          <AlertDialogDescription>
            {removing === null ? "" : removing.nested === 0 ? `Task ${removing.taskId} will be removed from the draft.`
              : `Task ${removing.taskId} and the ${removing.nested} task${removing.nested === 1 ? "" : "s"} inside it will be removed from the draft.`}
            {" "}You can undo this before you save.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep task</AlertDialogCancel>
          <AlertDialogAction onClick={remove}>Remove task</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <p role="status" aria-live="polite" className="text-sm">{status}</p>
  </section>;
}
