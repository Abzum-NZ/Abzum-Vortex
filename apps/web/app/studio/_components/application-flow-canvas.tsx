"use client";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { Badge } from "@vortex/ui/components/badge";
import type { SourceFlow, SourceFlowTask } from "@vortex/platform/schema";
import {
  projectStudioFlowTextEditor,
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

// Structure keys hold child task lists; they are drawn as branches, not as settings.
const structureKeys = new Set(["id", "type", "description", "then", "else", "tasks", "default", "branches"]);

// Switch cases keep their `when` predicate visible; only the nested task lists are drawn as branches.
const withoutBranchTasks = (key: string, value: unknown): unknown =>
  key === "cases" && Array.isArray(value)
    ? value.map((entry) => {
      if (typeof entry !== "object" || entry === null) return entry;
      const { tasks: _tasks, ...rest } = entry as Record<string, unknown>;
      return rest;
    })
    : value;

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
      const id = `group:${list.label}`;
      headerIds.push(id);
      nodes.push({
        id, type: "canvas", draggable: false, connectable: false, position: { x: left, y: 0 },
        data: { title: list.label, caption: "Runs after the main tasks", kind: "group" },
      });
    }
    if (hasHeader) top = nodeHeight + rowGap;
    const layout = layoutList(flow, list, left, top, nodes, edges);
    for (const header of headerIds) for (const first of layout.firstIds)
      edges.push({ id: `${header}>${first}`, source: header, target: first });
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

const describeValue = (value: unknown): string => {
  try { return JSON.stringify(value, null, 2) ?? String(value); }
  catch (cause) {
    console.error("Flow canvas could not render a task setting", cause);
    return "This setting cannot be shown.";
  }
};

function TaskSettings({ flow, outline }: Readonly<{ flow: SourceFlow; outline: StudioFlowTaskOutline }>) {
  const task = taskAt(flow, outline.path);
  useEffect(() => {
    if (task === undefined || task.id !== outline.id)
      console.error("Flow canvas could not find the selected task", { flow: flow.id, path: outline.path });
  }, [flow.id, outline.id, outline.path, task]);
  if (task === undefined || task.id !== outline.id)
    return <p role="status" className="text-sm text-muted-foreground">
      This task has an unsupported shape. Its settings cannot be shown.</p>;
  const settings = Object.entries(task).filter(([key]) => !structureKeys.has(key));
  return <dl className="space-y-2 text-sm">
    {task.description !== undefined && <div><dt className="text-muted-foreground">Description</dt><dd>{task.description}</dd></div>}
    {settings.length === 0 ? <p className="text-muted-foreground">This task has no settings.</p>
      : settings.map(([key, value]) => <div key={key}>
        <dt className="text-muted-foreground">{key}</dt>
        <dd><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted p-2 text-xs">{describeValue(withoutBranchTasks(key, value))}</pre></dd>
      </div>)}
  </dl>;
}

/** Read-only view of the draft flow's task list; it consumes the same projection as the text editor. */
export function ApplicationFlowCanvas({ context, selection }: Readonly<{
  context: StudioFlowTextContext;
  selection: FlowSelection;
}>) {
  const projection = useMemo(() => projectStudioFlowTextEditor(context, selection), [context, selection]);
  const flow = useMemo(() => context.source.body.flows.find((entry) => entry.id === selection.flowAlias), [context, selection]);
  const graph = useMemo(() => projection.kind === "available" && flow !== undefined
    ? buildGraph(flow, projection.lists) : null, [projection, flow]);
  // A selection belongs to one flow and one task id, so it cannot leak across flow switches or edits.
  const [selected, setSelected] = useState<Readonly<{ flowAlias: string; key: string; id: string }> | null>(null);

  useEffect(() => {
    if (projection.kind !== "available" || flow === undefined)
      console.error("Flow canvas projection is unavailable", { flow: selection.flowAlias, projection: projection.kind });
  }, [projection.kind, flow, selection.flowAlias]);

  if (graph === null || projection.kind !== "available" || flow === undefined)
    return <p role="status">This Flow canvas is unavailable because the flow could not be read.</p>;

  const candidate = selected !== null && selected.flowAlias === selection.flowAlias
    ? findOutline(projection.lists, selected.key) : undefined;
  const selectedOutline = candidate !== undefined && candidate.id === selected?.id ? candidate : undefined;
  const selectedKey = selectedOutline === undefined ? null : selected?.key ?? null;
  const themed = {
    "--xy-edge-stroke-default": "var(--border)",
    "--xy-edge-label-color-default": "var(--muted-foreground)",
    "--xy-edge-label-background-color-default": "var(--background)",
    "--xy-background-color-default": "var(--background)",
    "--xy-controls-button-background-color-default": "var(--card)",
    "--xy-controls-button-color-default": "var(--card-foreground)",
    "--xy-controls-button-border-color-default": "var(--border)",
  } as CSSProperties;

  return <section className="space-y-3" aria-label="Flow canvas">
    <h3 className="font-medium">Flow canvas <Badge variant="secondary">Read only</Badge></h3>
    <div className="h-96 rounded-xl border border-border" style={themed}>
      <ReactFlow nodes={graph.nodes.map((node) => ({ ...node, selected: node.id === selectedKey }))} edges={graph.edges}
        nodeTypes={nodeTypes} fitView nodesDraggable={false} nodesConnectable={false} edgesFocusable={false}
        elementsSelectable proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => {
          const outline = node.id.startsWith("[") ? findOutline(projection.lists, node.id) : undefined;
          setSelected(outline === undefined ? null : { flowAlias: selection.flowAlias, key: node.id, id: outline.id });
        }}
        onPaneClick={() => setSelected(null)}>
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
    {selectedOutline === undefined
      ? <p className="text-sm text-muted-foreground">Select a task to see its settings.</p>
      : <div className="space-y-2 rounded-xl border border-border bg-card p-3 text-card-foreground" aria-live="polite">
        <h4 className="font-medium">{selectedOutline.title}</h4>
        <p className="text-sm"><span className="text-muted-foreground">Id:</span> {selectedOutline.id}
          {" "}<span className="text-muted-foreground">Type:</span> {selectedOutline.type}</p>
        <TaskSettings flow={flow} outline={selectedOutline} />
      </div>}
  </section>;
}
