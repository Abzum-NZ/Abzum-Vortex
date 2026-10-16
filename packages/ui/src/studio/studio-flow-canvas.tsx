"use client";
import "@xyflow/react/dist/style.css";
import { useMemo, type CSSProperties } from "react";
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { Badge } from "../components/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "../components/card";
import { cn } from "../lib/utils";
import type { StudioFlowPath, StudioFlowTaskListOutline } from "./application-flow-model";

/**
 * The workflow canvas: the stored flow drawn as a graph. How it starts, its steps top to bottom,
 * each decision's branches side by side below it, and where it ends; the failure and final lists
 * sit beside the main steps. Positions are computed every time from the authored lists, so the
 * canvas stores nothing of its own. React Flow (`@xyflow/react`) draws it; the nodes are shadcn
 * cards on the platform theme's tokens.
 */

type NodeKind = "start" | "step" | "group" | "end";
type CanvasNodeData = Readonly<{ title: string; caption: string; kind: NodeKind; badge?: string }>;

const nodeWidth = 240;
const nodeHeight = 64;
const columnGap = 40;
const rowGap = 44;

const pathKey = (path: StudioFlowPath): string => JSON.stringify(path);

function CanvasNode({ data, selected }: NodeProps<Node<CanvasNodeData>>) {
  return <Card size="sm" style={{ width: nodeWidth, minHeight: nodeHeight }}
    className={cn("gap-1 py-2", selected && "ring-2 ring-ring", data.kind === "step" ? "cursor-pointer" : "bg-muted text-muted-foreground")}>
    <Handle type="target" position={Position.Top} isConnectable={false} />
    <CardHeader className="gap-1 px-3">
      <CardTitle className="flex items-center gap-2 truncate text-sm">
        {data.badge === undefined ? null : <Badge variant="outline">{data.badge}</Badge>}
        <span className="truncate">{data.title}</span>
      </CardTitle>
      <CardDescription className="truncate text-xs">{data.caption}</CardDescription>
    </CardHeader>
    <Handle type="source" position={Position.Bottom} isConnectable={false} />
  </Card>;
}
const nodeTypes = { canvas: CanvasNode };

type Layout = Readonly<{ width: number; height: number; firstIds: readonly string[]; lastIds: readonly string[] }>;

const node = (id: string, x: number, y: number, data: CanvasNodeData): Node<CanvasNodeData> =>
  ({ id, type: "canvas", draggable: false, connectable: false, selectable: data.kind === "step", position: { x, y }, data });

/** Lists run top to bottom; a step's branches sit side by side below it and join again after it. */
function layoutList(list: StudioFlowTaskListOutline, left: number, top: number,
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
      const branch = layoutList(child, branchX, y, nodes, edges);
      branchX += branch.width + columnGap;
      branchHeight = Math.max(branchHeight, branch.height);
      return { child, branch };
    });
    const span = Math.max(nodeWidth, branchX - columnGap - left);
    nodes.push(node(id, left + (span - nodeWidth) / 2, nodeY, { title: task.title, caption: task.caption, kind: "step" }));
    for (const { child, branch } of branches)
      for (const first of branch.firstIds) edges.push({ id: `${id}>${first}`, source: id, target: first, label: child.label });
    if (previous.length > 0) for (const from of previous) edges.push({ id: `${from}>${id}`, source: from, target: id });
    else firstIds.push(id);
    // The next step follows where each branch ends; the deciding step itself falls through only
    // when a branch is empty or absent (no Else, no Otherwise).
    const ends = branches.flatMap(({ branch }) => branch.lastIds);
    const fallsThrough = branches.length === 0 || branches.some(({ branch }) => branch.lastIds.length === 0) ||
      (task.type === "if" && !task.children.some((child) => child.label === "Else")) ||
      (task.type === "switch" && !task.children.some((child) => child.label === "Otherwise"));
    previous = fallsThrough ? [id, ...ends] : ends;
    width = Math.max(width, span);
    y += branchHeight > 0 ? branchHeight + rowGap : 0;
  }
  return { width, height: y - top, firstIds, lastIds: previous };
}

const groupCaptions: Readonly<Record<string, Readonly<{ caption: string; edge: string }>>> = {
  "When a step fails": { caption: "Runs when a step fails", edge: "on failure" },
  "At the end": { caption: "Runs after the flow ends, however it ended", edge: "always" },
};

function buildGraph(lists: readonly StudioFlowTaskListOutline[], starts: readonly string[]) {
  const nodes: Node<CanvasNodeData>[] = [];
  const edges: Edge[] = [];
  let left = 0;
  lists.forEach((list, index) => {
    if (index > 0 && list.tasks.length === 0) return;
    const headers: string[] = [];
    if (index === 0) {
      (starts.length === 0 ? ["Started by another flow or not started yet"] : starts).forEach((start, startIndex) => {
        const id = `start:${startIndex}`;
        headers.push(id);
        nodes.push(node(id, left + startIndex * (nodeWidth + columnGap), 0, { title: start, caption: "How this flow starts", kind: "start", badge: "Start" }));
      });
    } else {
      const id = `group:${index}`;
      headers.push(id);
      nodes.push(node(id, left, 0, { title: list.label, caption: groupCaptions[list.label]?.caption ?? list.label, kind: "group" }));
    }
    const layout = layoutList(list, left, nodeHeight + rowGap, nodes, edges);
    for (const header of headers) for (const first of layout.firstIds)
      edges.push({ id: `${header}>${first}`, source: header, target: first, ...(index === 0 ? {} : { label: groupCaptions[list.label]?.edge }) });
    if (index === 0) {
      const end = "end";
      nodes.push(node(end, left + (layout.width - nodeWidth) / 2, nodeHeight + rowGap + layout.height,
        { title: "End", caption: "The flow is done", kind: "end", badge: "End" }));
      for (const last of layout.lastIds) edges.push({ id: `${last}>${end}`, source: last, target: end });
    }
    left += Math.max(layout.width, headers.length * (nodeWidth + columnGap) - columnGap) + columnGap * 2;
  });
  return { nodes, edges };
}

const themed = {
  "--xy-edge-stroke-default": "var(--muted-foreground)",
  "--xy-edge-label-color-default": "var(--muted-foreground)",
  "--xy-edge-label-background-color-default": "var(--background)",
  "--xy-background-color-default": "var(--background)",
  "--xy-background-pattern-color-default": "var(--border)",
  "--xy-controls-button-background-color-default": "var(--card)",
  "--xy-controls-button-color-default": "var(--card-foreground)",
  "--xy-controls-button-border-color-default": "var(--border)",
  "--xy-node-border-radius-default": "0",
} as CSSProperties;

export function StudioFlowCanvas({ lists, starts, selectedPath, onSelect, label }: Readonly<{
  lists: readonly StudioFlowTaskListOutline[];
  /** How the flow starts, in words: one entry per trigger or bound control event. */
  starts: readonly string[];
  selectedPath: StudioFlowPath | null;
  /** A step was chosen on the canvas (its path), or the empty canvas (null). */
  onSelect: (path: StudioFlowPath | null) => void;
  label: string;
}>) {
  const graph = useMemo(() => buildGraph(lists, starts), [lists, starts]);
  const selectedKey = selectedPath === null ? null : pathKey(selectedPath);
  return <div className="h-full min-h-96 w-full border border-border" style={themed} aria-label={label} role="group">
    <ReactFlow nodes={graph.nodes.map((entry) => ({ ...entry, selected: entry.id === selectedKey }))} edges={graph.edges}
      nodeTypes={nodeTypes} fitView fitViewOptions={{ maxZoom: 1 }} nodesDraggable={false} nodesConnectable={false}
      edgesFocusable={false} elementsSelectable proOptions={{ hideAttribution: true }}
      onNodeClick={(_, clicked) => {
        if (clicked.data.kind !== "step") return;
        onSelect(JSON.parse(clicked.id) as StudioFlowPath);
      }}
      onPaneClick={() => onSelect(null)}>
      <Background />
      <Controls showInteractive={false} />
    </ReactFlow>
  </div>;
}
