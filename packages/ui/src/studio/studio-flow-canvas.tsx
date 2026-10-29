"use client";
import "@xyflow/react/dist/style.css";
import type { FlowTaskTypeKey } from "@vortex/platform/schema";
import { createContext, memo, useContext, useId, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Panel,
  Position,
  ReactFlow,
  getSmoothStepPath,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  ArchiveRestore,
  Braces,
  Calculator,
  CaseSensitive,
  CircleCheck,
  CircleHelp,
  CircleX,
  ClipboardCheck,
  ClipboardList,
  FilePlus2,
  Filter,
  Flag,
  GitBranch,
  Layers,
  Link,
  Link2,
  ListFilter,
  ListOrdered,
  MapPin,
  Maximize,
  Megaphone,
  MessageSquare,
  MessageSquareX,
  Navigation,
  Octagon,
  PanelLeft,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Repeat2,
  Save,
  Search,
  Split,
  SquarePen,
  Timer,
  Trash2,
  TriangleAlert,
  Variable,
  Workflow,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { Card } from "../components/card";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../components/popover";
import { cn } from "../lib/utils";
import type { ThemeMode } from "../theme";
import type { StudioFlowNewStepSettings } from "./application-flow-commands";
import type { StudioFlowPath, StudioFlowTaskListOutline } from "./application-flow-model";
import {
  StudioFlowStepPicker,
  type StudioFlowStepChoice,
  type StudioFlowStepPickerContext,
} from "./studio-flow-step-picker";

/** The graph is a view of the authored lists; no canvas positions or graph state are stored. */
type NodeKind = "start" | "step" | "group" | "end" | "insert";
type FlowNodeData = Readonly<{
  title: string;
  caption: string;
  kind: NodeKind;
  taskType?: string;
  taskId?: string;
  location?: "page" | "server" | "backend";
  behaviour?: readonly string[];
  insertion?: Insertion;
}>;
type FlowPlacement = Readonly<{
  tasks: Readonly<Record<string, "page" | "server" | "backend">>;
  bands: readonly Readonly<{ id: string; taskIds: readonly string[] }>[];
}>;
type Insertion = Readonly<{ listPath: StudioFlowPath; index: number }>;
type FlowEdge = Edge<Readonly<{ insertion: Insertion; label: string }>, "studio">;
type AddStep = (
  insertion: Insertion,
  taskType: string,
  settings: StudioFlowNewStepSettings,
) => true | string;
type CanvasActions = Readonly<{
  typesAt: (insertion: Insertion) => readonly StudioFlowStepChoice[];
  disabled: boolean;
  onAdd: AddStep;
  choicesAt: (insertion: Insertion) => StudioFlowStepPickerContext;
}>;
const ActionsContext = createContext<CanvasActions | null>(null);

const nodeWidth = 256;
const nodeHeight = 96;
const columnGap = 64;
const rowGap = 80;
const pathKey = (path: StudioFlowPath): string => JSON.stringify(path);

const taskIcons: Readonly<Record<string, LucideIcon>> = {
  if: GitBranch,
  switch: Split,
  for_each: Repeat2,
  sequential: ListOrdered,
  run_flow: Workflow,
  stop: Octagon,
  "record.save": Save,
  "record.create": FilePlus2,
  "record.set_fields": SquarePen,
  "record.link": Link2,
  "record.delete": Trash2,
  "record.restore": ArchiveRestore,
  "record.changes": Layers,
  "record.query": Search,
  "record.read_fields": ListFilter,
  "record.pin_identity": MapPin,
  "operation.call": Plug,
  "backend.run": Timer,
  "event.announce": Megaphone,
  "data.calculate": Calculator,
  "data.record_link": Link,
  "data.set_values": Braces,
  "data.set_variable": Variable,
  "data.format": CaseSensitive,
  "rule.require": CircleCheck,
  "rule.warn": TriangleAlert,
  "rule.refuse": CircleX,
  "interface.show_message": MessageSquare,
  "interface.clear_message": MessageSquareX,
  "interface.set_value": Variable,
  "interface.validate_form": ClipboardCheck,
  "interface.show_form": ClipboardList,
  "interface.confirm": CircleHelp,
  "interface.navigate": Navigation,
  "interface.refresh": RefreshCw,
  "interface.set_panel": PanelLeft,
  "interface.set_filter": Filter,
} satisfies Record<FlowTaskTypeKey, LucideIcon>;

const StudioFlowNode = memo(function StudioFlowNode({
  data,
  selected,
}: NodeProps<Node<FlowNodeData>>) {
  const Icon =
    data.kind === "start"
      ? Play
      : data.kind === "end"
        ? Flag
        : (taskIcons[data.taskType ?? ""] ?? Workflow);
  const handle =
    "size-2! rounded-full! border-background! bg-border! opacity-0 group-hover/node:opacity-100 group-focus-visible/flow-node:opacity-100";
  return (
    <Card
      className={cn(
        "group/node relative min-h-24 w-64 gap-2 rounded-xl border bg-card px-3 py-2.5 text-card-foreground shadow-xs hover:border-foreground/20 group-focus-visible/flow-node:ring-2 group-focus-visible/flow-node:ring-primary",
        data.kind !== "start" && "h-24",
        selected && "ring-2 ring-primary shadow-lg",
      )}
    >
      {data.kind !== "start" && data.kind !== "group" && (
        <Handle type="target" position={Position.Top} isConnectable={false} className={handle} />
      )}
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-foreground",
            data.kind === "start" && "bg-primary/10 text-primary",
            data.taskType === "stop" && "bg-destructive/10 text-destructive",
          )}
        >
          <Icon aria-hidden="true" className="size-4" />
        </span>
        <span className="truncate text-sm font-medium" title={data.title}>
          {data.title}
        </span>
      </div>
      <p className="line-clamp-2 text-xs text-muted-foreground" title={data.caption}>
        {data.caption}
      </p>
      {data.kind === "start" && (
        <div className="text-xs text-muted-foreground">
          <span className="font-medium">Behaviour</span>
          {data.behaviour?.length ? (
            <ul>
              {data.behaviour.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          ) : (
            <p>No components bound</p>
          )}
        </div>
      )}
      {data.location === undefined ? null : (
        <Badge variant="secondary" className="absolute right-2 bottom-1 text-xs">
          {data.location === "page"
            ? "Page"
            : data.location === "server"
              ? "Server"
              : "Back end (simulated)"}
        </Badge>
      )}
      {data.kind !== "end" && (
        <Handle type="source" position={Position.Bottom} isConnectable={false} className={handle} />
      )}
    </Card>
  );
});
const StudioFlowInsertion = memo(function StudioFlowInsertion({
  data,
}: NodeProps<Node<FlowNodeData>>) {
  const actions = useContext(ActionsContext);
  const id = useId();
  const [request, setRequest] = useState<CanvasActions | null>(null);
  const [problem, setProblem] = useState("");
  if (actions === null || data.insertion === undefined)
    throw new Error("Flow insertion requires canvas actions and a position.");
  const insertion = data.insertion;
  return (
    <Popover
      open={request !== null}
      onOpenChange={(open) => {
        setRequest(open ? actions : null);
        setProblem("");
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            aria-label={data.title}
            title={actions.disabled ? "This draft is read-only" : data.title}
            disabled={actions.disabled}
            className="rounded-full bg-card focus-visible:ring-2 focus-visible:ring-primary"
          />
        }
      >
        <Plus aria-hidden="true" className="size-3" />
      </PopoverTrigger>
      <PopoverContent className="w-80" onKeyDown={(event) => event.stopPropagation()}>
        <PopoverTitle>Add a step</PopoverTitle>
        <StudioFlowStepPicker
          context={(request ?? actions).choicesAt(insertion)}
          id={id}
          label="Kind of step"
          types={(request ?? actions).typesAt(insertion)}
          disabled={actions.disabled}
          action="Add step"
          onAdd={(taskType, settings) => {
            if (request === null) return false;
            const result = request.onAdd(insertion, taskType, settings);
            if (result === true) {
              setRequest(null);
              setProblem("");
            } else setProblem(result);
            return result === true;
          }}
        />
        {problem === "" ? null : (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {problem}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
});
const nodeTypes = { studio: StudioFlowNode, insertion: StudioFlowInsertion };

const StudioFlowEdge = memo(function StudioFlowEdge(props: EdgeProps<FlowEdge>) {
  const [path, x, y] = getSmoothStepPath(props);
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        interactionWidth={24}
        style={{ stroke: "var(--muted-foreground)", strokeWidth: 1.5 }}
      />
      {props.label === undefined ? null : (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute"
            style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
          >
            <Badge variant="secondary" className="rounded-full">
              {props.label}
            </Badge>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
const edgeTypes = { studio: StudioFlowEdge };

function StudioFlowControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  return (
    <Panel
      position="bottom-left"
      className="flex flex-col rounded-lg border bg-card p-1 text-card-foreground shadow-xs"
      aria-label="Canvas zoom"
      role="group"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Zoom in"
        title="Zoom in"
        onClick={() => {
          void zoomIn();
        }}
      >
        <ZoomIn aria-hidden="true" className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Zoom out"
        title="Zoom out"
        onClick={() => {
          void zoomOut();
        }}
      >
        <ZoomOut aria-hidden="true" className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Fit flow to canvas"
        title="Fit flow to canvas"
        onClick={() => {
          void fitView({ maxZoom: 1 });
        }}
      >
        <Maximize aria-hidden="true" className="size-4" />
      </Button>
    </Panel>
  );
}

type Outlet = Readonly<{ id: string; insertion: Insertion }>;
type Layout = Readonly<{
  width: number;
  height: number;
  firstIds: readonly string[];
  outlets: readonly Outlet[];
}>;
const node = (id: string, x: number, y: number, data: FlowNodeData): Node<FlowNodeData> => ({
  id,
  type: "studio",
  className: "group/flow-node",
  draggable: false,
  connectable: false,
  selectable: data.kind === "step" || data.kind === "start",
  focusable: true,
  ariaRole: data.kind === "step" || data.kind === "start" ? "button" : "group",
  position: { x, y },
  data,
  ariaLabel: `${data.title}. ${data.caption}`,
});
const edge = (
  source: string,
  target: string,
  insertion: Insertion,
  label: string,
  branch?: string,
): FlowEdge => ({
  id: `${source}>${target}:${pathKey(insertion.listPath)}:${insertion.index}`,
  source,
  target,
  type: "studio",
  label: branch,
  data: { insertion, label },
});

/** Lists run top to bottom. A branch's outgoing edge appends inside that branch, before it rejoins. */
function layoutList(
  list: StudioFlowTaskListOutline,
  left: number,
  top: number,
  nodes: Node<FlowNodeData>[],
  edges: FlowEdge[],
): Layout {
  let y = top;
  let width = nodeWidth;
  let previous: readonly Outlet[] = [];
  const firstIds: string[] = [];
  list.tasks.forEach((task, index) => {
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
    nodes.push(
      node(id, left + (span - nodeWidth) / 2, nodeY, {
        title: task.title,
        caption: task.caption,
        kind: "step",
        taskType: task.type,
        taskId: task.id,
      }),
    );
    for (const { child, branch } of branches)
      for (const first of branch.firstIds)
        edges.push(
          edge(
            id,
            first,
            { listPath: child.path, index: 0 },
            `Add a step to ${child.label}`,
            child.label,
          ),
        );
    if (previous.length > 0)
      for (const from of previous)
        edges.push(edge(from.id, id, from.insertion, `Add a step before ${task.title}`));
    else firstIds.push(id);
    const ends = branches.flatMap(({ branch }) => branch.outlets);
    const fallsThrough =
      branches.length === 0 ||
      branches.some(({ branch }) => branch.outlets.length === 0) ||
      (task.type === "if" && !task.children.some((child) => child.label === "Else")) ||
      (task.type === "switch" && !task.children.some((child) => child.label === "Otherwise"));
    previous = fallsThrough
      ? [{ id, insertion: { listPath: list.path, index: index + 1 } }, ...ends]
      : ends;
    width = Math.max(width, span);
    y += branchHeight > 0 ? branchHeight + rowGap : 0;
  });
  return { width, height: y - top, firstIds, outlets: previous };
}

const groupCaptions: Readonly<Record<string, Readonly<{ caption: string; edge: string }>>> = {
  "When a step fails": { caption: "Runs when a step fails", edge: "on failure" },
  "At the end": { caption: "Runs after the flow ends, however it ended", edge: "always" },
};

function buildGraph(
  lists: readonly StudioFlowTaskListOutline[],
  starts: readonly string[],
  behaviour: readonly string[],
) {
  const nodes: Node<FlowNodeData>[] = [];
  const edges: FlowEdge[] = [];
  let left = 0;
  const startHeight = nodeHeight + 32 + Math.max(1, behaviour.length) * 20;
  lists.forEach((list, index) => {
    if (index > 0 && list.tasks.length === 0) return;
    const headers: string[] = [];
    if (index === 0) {
      (starts.length === 0 ? ["Started by another flow or not started yet"] : starts).forEach(
        (start, startIndex) => {
          const id = `start:${startIndex}`;
          headers.push(id);
          nodes.push(
            node(id, left + startIndex * (nodeWidth + columnGap), 0, {
              title: "Start",
              caption: start,
              kind: "start",
              behaviour,
            }),
          );
        },
      );
    } else {
      const id = `group:${index}`;
      headers.push(id);
      nodes.push(
        node(id, left, 0, {
          title: list.label,
          caption: groupCaptions[list.label]?.caption ?? list.label,
          kind: "group",
        }),
      );
    }
    const layout = layoutList(list, left, startHeight + rowGap, nodes, edges);
    for (const header of headers)
      for (const first of layout.firstIds)
        edges.push(
          edge(
            header,
            first,
            { listPath: list.path, index: 0 },
            "Add a step at the start",
            index === 0 ? undefined : groupCaptions[list.label]?.edge,
          ),
        );
    if (index === 0) {
      const end = "end";
      nodes.push(
        node(end, left + (layout.width - nodeWidth) / 2, startHeight + rowGap + layout.height, {
          title: "End",
          caption: "The flow is done",
          kind: "end",
        }),
      );
      for (const last of layout.outlets)
        edges.push(edge(last.id, end, last.insertion, "Add a step at the end"));
      if (layout.firstIds.length === 0)
        for (const header of headers)
          edges.push(edge(header, end, { listPath: list.path, index: 0 }, "Add the first step"));
    }
    left +=
      Math.max(layout.width, headers.length * (nodeWidth + columnGap) - columnGap) + columnGap * 2;
  });
  const byId = new Map(nodes.map((entry) => [entry.id, entry]));
  const insertions: Node<FlowNodeData>[] = edges.flatMap((entry) => {
    const from = byId.get(entry.source);
    const to = byId.get(entry.target);
    if (from === undefined || to === undefined || entry.data === undefined) return [];
    const fromHeight = from.data.kind === "start" ? startHeight : nodeHeight;
    return [
      {
        id: `insert:${entry.id}`,
        type: "insertion",
        position: {
          x: (from.position.x + to.position.x) / 2 + nodeWidth / 2 - 12,
          y: (from.position.y + fromHeight + to.position.y) / 2 - 12,
        },
        data: {
          title: entry.data.label,
          caption: "",
          kind: "insert",
          insertion: entry.data.insertion,
        },
        selectable: false,
        focusable: false,
        draggable: false,
        connectable: false,
      },
    ];
  });
  return {
    nodes: [...nodes, ...insertions].sort(
      (a, b) => a.position.y - b.position.y || a.position.x - b.position.x,
    ),
    edges,
  };
}

export function StudioFlowCanvas({
  lists,
  starts,
  behaviour,
  selectedPath,
  onSelect,
  label,
  title,
  appearance,
  typesAt,
  disabled,
  onAdd,
  choicesAt,
  placement,
}: Readonly<{
  lists: readonly StudioFlowTaskListOutline[];
  starts: readonly string[];
  behaviour: readonly string[];
  selectedPath: StudioFlowPath | null;
  /** null selects the flow's start settings. */
  onSelect: (path: StudioFlowPath | null) => void;
  label: string;
  title: string;
  appearance: ThemeMode;
  typesAt: (insertion: Insertion) => readonly StudioFlowStepChoice[];
  disabled: boolean;
  onAdd: AddStep;
  choicesAt: (insertion: Insertion) => StudioFlowStepPickerContext;
  placement: FlowPlacement | null;
}>) {
  const previousData = useRef(new Map<string, FlowNodeData>());
  const graph = useMemo(() => {
    const next = buildGraph(lists, starts, behaviour);
    const data = new Map<string, FlowNodeData>();
    const nodes = next.nodes.map((entry) => {
      const previous = previousData.current.get(entry.id);
      const location =
        entry.data.taskId === undefined ? undefined : placement?.tasks[entry.data.taskId];
      const current = {
        ...entry.data,
        ...(location === undefined ? {} : { location }),
      };
      const stable =
        previous !== undefined &&
        previous.title === current.title &&
        previous.caption === current.caption &&
        previous.kind === current.kind &&
        previous.taskType === current.taskType &&
        previous.taskId === current.taskId &&
        previous.location === current.location &&
        JSON.stringify(previous.behaviour) === JSON.stringify(current.behaviour) &&
        JSON.stringify(previous.insertion) === JSON.stringify(current.insertion)
          ? previous
          : current;
      data.set(entry.id, stable);
      return { ...entry, data: stable };
    });
    previousData.current = data;
    const bands: Node<FlowNodeData>[] = (placement?.bands ?? []).flatMap((band) => {
      const members = nodes.filter(
        (entry) => entry.data.taskId !== undefined && band.taskIds.includes(entry.data.taskId),
      );
      if (members.length === 0) return [];
      const left = Math.min(...members.map((entry) => entry.position.x)) - 24;
      const top = Math.min(...members.map((entry) => entry.position.y)) - 24;
      const right = Math.max(...members.map((entry) => entry.position.x + nodeWidth)) + 24;
      const bottom = Math.max(...members.map((entry) => entry.position.y + nodeHeight)) + 24;
      return [
        {
          id: `band:${band.id}`,
          type: "default",
          position: { x: left, y: top },
          data: { title: "Server segment", caption: "", kind: "group" },
          style: { width: right - left, height: bottom - top, zIndex: -1, pointerEvents: "none" },
          className: "border border-primary/20 bg-primary/5! rounded-2xl!",
          selectable: false,
          focusable: false,
          draggable: false,
          connectable: false,
        },
      ];
    });
    return { ...next, nodes: [...bands, ...nodes] };
  }, [lists, starts, behaviour, placement]);
  const actions = useMemo(
    () => ({ typesAt, disabled, onAdd, choicesAt }),
    [typesAt, disabled, onAdd, choicesAt],
  );
  const selectedKey = selectedPath === null ? null : pathKey(selectedPath);
  const selectNode = (clicked: Node<FlowNodeData>) => {
    if (clicked.data.kind === "start") onSelect(null);
    else if (clicked.data.kind === "step") onSelect(JSON.parse(clicked.id) as StudioFlowPath);
  };
  return (
    <div
      className="flex h-full min-h-96 w-full flex-col bg-background"
      aria-label={label}
      role="group"
    >
      <div className="shrink-0 space-y-1 px-3 py-3">
        <p className="m-0 truncate text-sm font-medium">{title}</p>
        <p className="m-0 line-clamp-2 text-sm text-muted-foreground">
          {starts.join(" · ") || "Started by another flow or not started yet"}
        </p>
      </div>
      <div className="min-h-0 flex-1">
        <ActionsContext.Provider value={actions}>
          <ReactFlow
            nodes={graph.nodes.map((entry) => ({
              ...entry,
              selected:
                selectedKey === null ? entry.data.kind === "start" : entry.id === selectedKey,
              domAttributes: {
                "aria-pressed": entry.selectable
                  ? selectedKey === null
                    ? entry.data.kind === "start"
                    : entry.id === selectedKey
                  : undefined,
              },
            }))}
            edges={graph.edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            colorMode={appearance}
            className="bg-background!"
            fitView
            fitViewOptions={{ maxZoom: 1 }}
            nodesDraggable={false}
            nodesConnectable={false}
            edgesFocusable={false}
            deleteKeyCode={null}
            elementsSelectable
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_, clicked) => selectNode(clicked)}
            onKeyDown={(event) => {
              const target = event.target;
              if (
                !(target instanceof HTMLElement) ||
                !target.classList.contains("react-flow__node")
              )
                return;
              const clicked = graph.nodes.find(
                (entry) => entry.id === target.getAttribute("data-id"),
              );
              if (clicked !== undefined && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                selectNode(clicked);
              } else if (event.key === "Escape") onSelect(null);
            }}
            onPaneClick={() => onSelect(null)}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
            <StudioFlowControls />
          </ReactFlow>
        </ActionsContext.Provider>
      </div>
    </div>
  );
}
