import {
  applicationRootIdSchema,
  applicationSourceDocumentV2Schema,
  builderKeySchema,
  flowLiteralSchema,
  flowMaximumTaskCount,
  flowMaximumTaskNestingDepth,
  flowTaskRegistry,
  organizationIdSchema,
  sourceFlowTaskSchema,
  type ApplicationRootId,
  type ApplicationSourceDocumentV2,
  type SourceFlow,
  type SourceFlowTask,
} from "@vortex/contracts";
import type { StudioSemanticSelection } from "./semantic-selection";

/** Client snapshots prevent stale edits; they provide no permission or execution authority. */
export type StudioFlowTextContext = Readonly<{
  organizationId: string;
  rootId: ApplicationRootId;
  key: string;
  draftRevision: number;
  localLifetime: number;
  source: Readonly<ApplicationSourceDocumentV2>;
}>;

export type StudioFlowTextProperty = Readonly<{ key: string; label: string; value: string }>;
export type StudioFlowTaskOutline = Readonly<{
  id: string;
  title: string;
  type: string;
  path: readonly (string | number)[];
  properties: readonly StudioFlowTextProperty[];
  children: readonly StudioFlowTaskListOutline[];
}>;
export type StudioFlowTaskListOutline = Readonly<{
  label: string;
  path: readonly (string | number)[];
  tasks: readonly StudioFlowTaskOutline[];
}>;
export type StudioFlowTextProjection =
  | Readonly<{ kind: "available"; lists: readonly StudioFlowTaskListOutline[] }>
  | Readonly<{ kind: "invalid" }>;
export type StudioFlowTextCommand = Readonly<{
  taskId: string;
  taskPath: readonly (string | number)[];
  property: string;
  text: string;
}>;
export type StudioFlowTextResult =
  | Readonly<{ kind: "applied"; source: ApplicationSourceDocumentV2 }>
  | Readonly<{ kind: "stale" | "unsupported" | "invalid" | "no_change" }>;

export type StudioFlowPresentationTaskType = "interface.show_message" | "interface.confirm";
export type StudioFlowPresentationPaletteEntry = Readonly<{
  type: StudioFlowPresentationTaskType;
  version: "1.0.0";
  title: string;
  optionalTitle: boolean;
}>;
export type StudioFlowPresentationCommand = Readonly<{
  kind: "append_presentation";
  taskId: string;
  message: string;
}> & (
  | Readonly<{ taskType: "interface.show_message"; title?: never }>
  | Readonly<{ taskType: "interface.confirm"; title?: string }>
);

type FlowSelection = Extract<StudioSemanticSelection, { kind: "flow" }>;
type TaskEntry = Readonly<{ task: SourceFlowTask; path: readonly (string | number)[] }>;

function invalidOutline(): never {
  throw new TypeError("Invalid authored Flow outline");
}

const samePath = (left: readonly (string | number)[], right: readonly (string | number)[]) =>
  left.length === right.length && left.every((part, index) => part === right[index]);

const validContext = (context: StudioFlowTextContext): boolean =>
  organizationIdSchema.safeParse(context.organizationId).success &&
  applicationRootIdSchema.safeParse(context.rootId).success &&
  context.key === context.source.key &&
  Number.isSafeInteger(context.draftRevision) && context.draftRevision > 0 &&
  Number.isSafeInteger(context.localLifetime) && context.localLifetime > 0 &&
  applicationSourceDocumentV2Schema.safeParse(context.source).success;

const editableProperties = (
  flow: SourceFlow,
  task: SourceFlowTask,
): readonly StudioFlowTextProperty[] => {
  if (flow.execution !== "interactive" || !("version" in task) || !("properties" in task))
    return [];
  // A text declaration may name an identity. Only these exact presentation pairs are editable.
  const keys = task.type === "interface.confirm" ? ["title", "message"]
    : task.type === "interface.show_message" ? ["message"] : [];
  const definition = Object.values(flowTaskRegistry).find((entry) => entry.type === task.type);
  if (task.version !== "1.0.0" || definition === undefined || definition.version !== task.version ||
    !definition.runLocations.includes("browser")) return [];
  return keys.flatMap((key) => {
    if (!Object.hasOwn(task.properties, key)) return [];
    const declaration = definition.properties[key];
    const value = task.properties[key];
    if ((declaration?.type !== "text" && declaration?.type !== "message_text") ||
      value?.kind !== "literal" || value.literal.type !== "text" ||
      typeof value.literal.value !== "string" || value.literal.value.length < 1 ||
      value.literal.value.length > 2_000 || !flowLiteralSchema.safeParse(value.literal).success)
      return [];
    return [{ key, label: key === "title" ? "Title" : "Message", value: value.literal.value }];
  });
};

/** Walks the real authored lists. No graph identity, inferred branch or cosmetic order is stored. */
const outline = (context: StudioFlowTextContext, selection: FlowSelection) => {
  if (!validContext(context)) return invalidOutline();
  const matches = context.source.body.flows.filter((flow) => flow.id === selection.flowAlias);
  const flow = matches[0];
  if (matches.length !== 1 || flow === undefined) return invalidOutline();
  const ids = new Set<string>();
  const entries: TaskEntry[] = [];
  let count = 0;
  const list = (label: string, tasks: readonly SourceFlowTask[],
    path: readonly (string | number)[], depth: number): StudioFlowTaskListOutline => ({
    label, path,
    tasks: tasks.map((task, index) => {
      if (++count > flowMaximumTaskCount || depth > flowMaximumTaskNestingDepth || ids.has(task.id))
        return invalidOutline();
      ids.add(task.id);
      const taskPath = [...path, index];
      entries.push({ task, path: taskPath });
      const children: StudioFlowTaskListOutline[] = [];
      switch (task.type) {
        case "if":
          if (!("then" in task)) return invalidOutline();
          children.push(list("Then", task.then, [...taskPath, "then"], depth + 1));
          if (task.else !== undefined)
            children.push(list("Else", task.else, [...taskPath, "else"], depth + 1));
          break;
        case "switch":
          if (!("cases" in task)) return invalidOutline();
          task.cases.forEach((branch, branchIndex) => children.push(list(`Case ${branch.key}`,
            branch.tasks, [...taskPath, "cases", branchIndex, "tasks"], depth + 1)));
          if (task.default !== undefined)
            children.push(list("Default", task.default, [...taskPath, "default"], depth + 1));
          break;
        case "for_each": case "sequential":
          if (!("tasks" in task)) return invalidOutline();
          children.push(list("Tasks", task.tasks, [...taskPath, "tasks"], depth + 1));
          break;
        case "parallel":
          if (!("branches" in task)) return invalidOutline();
          task.branches.forEach((branch, branchIndex) => children.push(list(`Branch ${branchIndex + 1}`,
            branch, [...taskPath, "branches", branchIndex], depth + 1)));
          break;
      }
      const definition = Object.values(flowTaskRegistry).find((entry) => entry.type === task.type);
      return { id: task.id, type: task.type, title: definition?.title ?? task.type,
        path: taskPath, properties: editableProperties(flow, task), children };
    }),
  });
  const lists = [list("Tasks", flow.tasks, ["tasks"], 1),
    list("Errors", flow.errors, ["errors"], 1), list("Finally", flow.finally, ["finally"], 1)];
  return { lists, entries, flow };
};

export const projectStudioFlowTextEditor = (
  context: StudioFlowTextContext,
  selection: FlowSelection,
): StudioFlowTextProjection => {
  try { return { kind: "available", lists: outline(context, selection).lists }; }
  catch { return { kind: "invalid" }; }
};

/** Changes one existing presentation value on the original detached authored source. */
export const applyStudioFlowTextCommand = (
  current: StudioFlowTextContext,
  expected: StudioFlowTextContext,
  selection: StudioSemanticSelection | null,
  expectedSelection: FlowSelection,
  command: StudioFlowTextCommand,
): StudioFlowTextResult => {
  if (current.organizationId !== expected.organizationId || current.rootId !== expected.rootId ||
    current.key !== expected.key || current.draftRevision !== expected.draftRevision ||
    current.localLifetime !== expected.localLifetime || current.source !== expected.source ||
    selection?.kind !== "flow" || selection.flowAlias !== expectedSelection.flowAlias)
    return { kind: "stale" };
  try {
    const original = outline(current, expectedSelection);
    const entry = original.entries.find(({ task, path }) => task.id === command.taskId &&
      samePath(path, command.taskPath));
    if (entry === undefined) return { kind: "stale" };
    const property = editableProperties(original.flow, entry.task)
      .find((item) => item.key === command.property);
    if (property === undefined) return { kind: "unsupported" };
    if (typeof command.text !== "string" || command.text.length < 1 || command.text.length > 2_000 ||
      !flowLiteralSchema.safeParse({ type: "text", value: command.text }).success)
      return { kind: "invalid" };
    if (command.text === property.value) return { kind: "no_change" };

    const candidate: ApplicationSourceDocumentV2 = structuredClone(current.source);
    const detached = outline({ ...current, source: candidate }, expectedSelection);
    const target = detached.entries.find(({ task, path }) => task.id === command.taskId &&
      samePath(path, command.taskPath));
    if (target === undefined || !("properties" in target.task)) return { kind: "invalid" };
    const value = target.task.properties[command.property];
    if (value?.kind !== "literal" || value.literal.type !== "text") return { kind: "invalid" };
    value.literal.value = command.text;
    if (!applicationSourceDocumentV2Schema.safeParse(candidate).success) return { kind: "invalid" };
    // The schema validates; its parsed defaults/transforms must not rewrite untouched source.
    return { kind: "applied", source: candidate };
  } catch { return { kind: "invalid" }; }
};

const presentationTypes: readonly StudioFlowPresentationTaskType[] = [
  "interface.show_message", "interface.confirm",
];

const presentationPalette = (): readonly StudioFlowPresentationPaletteEntry[] =>
  presentationTypes.flatMap((type): StudioFlowPresentationPaletteEntry[] => {
    const definition = Object.values(flowTaskRegistry).find((entry) => entry.type === type);
    if (definition === undefined || definition.version !== "1.0.0" ||
      definition.effect !== "interface" || !definition.runLocations.includes("browser") ||
      definition.properties.message?.type !== "message_text" || !definition.properties.message.required)
      return [];
    if (type === "interface.confirm" && (definition.properties.title?.type !== "message_text" ||
      definition.properties.title.required)) return [];
    return [{ type, version: "1.0.0", title: definition.title, optionalTitle: type === "interface.confirm" }];
  });

/** A closed registry-backed palette; it cannot construct a protected or unknown task. */
export const projectStudioFlowPresentationPalette = (
  context: StudioFlowTextContext,
  selection: FlowSelection,
): readonly StudioFlowPresentationPaletteEntry[] => {
  try {
    const current = outline(context, selection);
    return current.flow.execution === "interactive" && current.flow.runAs.kind === "initiator" &&
      current.entries.length < flowMaximumTaskCount ? presentationPalette() : [];
  } catch { return []; }
};

const validPresentationText = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= 2_000 &&
  flowLiteralSchema.safeParse({ type: "text", value }).success;

/** Appends one minimally authored presentation task; no other source or authority is rewritten. */
export const applyStudioFlowPresentationCommand = (
  current: StudioFlowTextContext,
  expected: StudioFlowTextContext,
  selection: StudioSemanticSelection | null,
  expectedSelection: FlowSelection,
  command: StudioFlowPresentationCommand,
): StudioFlowTextResult => {
  if (current.organizationId !== expected.organizationId || current.rootId !== expected.rootId ||
    current.key !== expected.key || current.draftRevision !== expected.draftRevision ||
    current.localLifetime !== expected.localLifetime || current.source !== expected.source ||
    selection?.kind !== "flow" || selection.flowAlias !== expectedSelection.flowAlias)
    return { kind: "stale" };
  try {
    const original = outline(current, expectedSelection);
    const definition = presentationPalette().find((entry) => entry.type === command.taskType);
    if (original.flow.execution !== "interactive" || original.flow.runAs.kind !== "initiator" ||
      definition === undefined || command.kind !== "append_presentation") return { kind: "unsupported" };
    const hasTitle = Object.hasOwn(command, "title");
    if (Object.keys(command).some((key) => !["kind", "taskType", "taskId", "message", "title"].includes(key)) ||
      (hasTitle && command.taskType !== "interface.confirm") ||
      !builderKeySchema.safeParse(command.taskId).success || !validPresentationText(command.message) ||
      (hasTitle && !validPresentationText(command.title)) ||
      original.entries.length >= flowMaximumTaskCount || original.entries.some(({ task }) => task.id === command.taskId))
      return { kind: "invalid" };
    const task: Extract<SourceFlowTask, { properties: unknown }> = {
      id: command.taskId, type: definition.type, version: definition.version,
      properties: { message: { kind: "literal", literal: { type: "text", value: command.message } } },
    };
    if (hasTitle && command.taskType === "interface.confirm" && typeof command.title === "string")
      task.properties.title = { kind: "literal", literal: { type: "text", value: command.title } };
    if (!sourceFlowTaskSchema.safeParse(task).success) return { kind: "invalid" };
    const candidate: ApplicationSourceDocumentV2 = structuredClone(current.source);
    const detached = outline({ ...current, source: candidate }, expectedSelection);
    detached.flow.tasks.push(task);
    // Recheck shared bounds and full source shape without adopting parsed defaults or transforms.
    outline({ ...current, source: candidate }, expectedSelection);
    if (!applicationSourceDocumentV2Schema.safeParse(candidate).success) return { kind: "invalid" };
    return { kind: "applied", source: candidate };
  } catch { return { kind: "invalid" }; }
};
