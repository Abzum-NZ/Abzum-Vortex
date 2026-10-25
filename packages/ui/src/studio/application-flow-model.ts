import { recordsTableInlineEditEvent, recordsTableRowEditEvent } from "@vortex/platform/schema";
import {
  applicationRootIdSchema,
  applicationSourceDocumentSchema,
  flowMaximumTaskCount,
  flowMaximumTaskNestingDepth,
  flowTaskRegistry,
  organizationIdSchema,
  validateFlow,
  type ApplicationRootId,
  type ApplicationSourceDocument,
  type ImmutablePlatformBlockCatalogue,
  type FlowTaskTypeDefinition,
  type FlowValidationIssue,
  type SourceFlow,
  type SourceFlowTask,
} from "@vortex/platform/schema";
import { studioFlowOfSelection, type StudioSemanticSelection } from "./semantic-selection";

/**
 * The one model every Flows-tab surface reads: where a flow lives in the application source (the
 * application's own flows or an owned Module's), its authored task lists as an outline with
 * human-readable titles and captions, and the one check an edited flow passes before the draft
 * takes it. The canvas, the step inspector and every flow command are views of this model; there
 * is no second flow format.
 */

/** Client snapshots prevent stale edits; they provide no permission or execution authority. */
export type StudioFlowContext = Readonly<{
  organizationId: string;
  rootId: ApplicationRootId;
  key: string;
  draftRevision: number;
  localLifetime: number;
  source: Readonly<ApplicationSourceDocument>;
  catalogue: ImmutablePlatformBlockCatalogue;
}>;

export type StudioFlowSelection = Extract<StudioSemanticSelection, { kind: "flow" }>;
export type StudioFlowPath = readonly (string | number)[];

export type StudioFlowTaskOutline = Readonly<{
  id: string;
  /** The task type's registered title, such as "Show message". */
  title: string;
  /** What this step does, in words: its description, or a summary of its main setting. */
  caption: string;
  type: string;
  path: StudioFlowPath;
  children: readonly StudioFlowTaskListOutline[];
}>;
export type StudioFlowTaskListOutline = Readonly<{
  label: string;
  path: StudioFlowPath;
  tasks: readonly StudioFlowTaskOutline[];
}>;

export type StudioFlowEntry = Readonly<{ task: SourceFlowTask; path: StudioFlowPath }>;
export type StudioFlowOutline = Readonly<{
  flow: SourceFlow;
  /** Every flow of the same owner, so Run flow targets resolve as compilation resolves them. */
  siblings: readonly SourceFlow[];
  lists: readonly StudioFlowTaskListOutline[];
  entries: readonly StudioFlowEntry[];
}>;

/** An edit the draft took, or why it refused it, in words a person can act on. */
export type StudioFlowEditResult =
  | Readonly<{ kind: "applied"; source: ApplicationSourceDocument; taskId: string }>
  | Readonly<{ kind: "stale" | "unsupported" | "invalid"; reason: string; cause?: unknown }>;

export const samePath = (left: StudioFlowPath, right: StudioFlowPath): boolean =>
  left.length === right.length && left.every((part, index) => part === right[index]);

export const studioFlowDefinitionOf = (
  type: string,
  version?: string,
): FlowTaskTypeDefinition | undefined => {
  const definition = Object.values(flowTaskRegistry).find((entry) => entry.type === type);
  return definition !== undefined && (version === undefined || definition.version === version)
    ? definition
    : undefined;
};

/** A key or alias as words: "mark_won" becomes "Mark won". */
export const studioWords = (key: string): string => {
  const words = key
    .trim()
    .replace(/[-_.]+/g, " ")
    .replace(/\s+/g, " ");
  return words === "" ? key : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

/** The flows of one owner in the source: the application's own, or an owned Module's. */
export const studioFlowCollection = (
  source: Readonly<ApplicationSourceDocument>,
  moduleKey: string | null,
): SourceFlow[] | undefined =>
  moduleKey === null
    ? source.body.flows
    : source.body.modules.find((module) => module.key === moduleKey)?.flows;

const validContext = (context: StudioFlowContext): boolean =>
  organizationIdSchema.safeParse(context.organizationId).success &&
  applicationRootIdSchema.safeParse(context.rootId).success &&
  context.key === context.source.key &&
  Number.isSafeInteger(context.draftRevision) &&
  context.draftRevision > 0 &&
  Number.isSafeInteger(context.localLifetime) &&
  context.localLifetime > 0;

export const sameStudioFlowContext = (
  current: StudioFlowContext,
  expected: StudioFlowContext,
  selection: StudioSemanticSelection | null,
  expectedSelection: StudioFlowSelection,
): boolean =>
  current.organizationId === expected.organizationId &&
  current.rootId === expected.rootId &&
  current.key === expected.key &&
  current.draftRevision === expected.draftRevision &&
  current.localLifetime === expected.localLifetime &&
  current.source === expected.source &&
  studioFlowOfSelection(selection)?.flowAlias === expectedSelection.flowAlias &&
  studioFlowOfSelection(selection)?.moduleKey === expectedSelection.moduleKey;

const literalText = (task: SourceFlowTask, key: string): string | undefined => {
  if (!("properties" in task)) return undefined;
  const value = task.properties[key];
  return value?.kind === "literal" &&
    typeof value.literal.value === "string" &&
    value.literal.value.length > 0
    ? value.literal.value
    : undefined;
};

const shorten = (text: string): string => (text.length > 70 ? `${text.slice(0, 67)}…` : text);

/** What a step does, in words; never its id. */
const taskCaption = (
  source: Readonly<ApplicationSourceDocument>,
  task: SourceFlowTask,
  definition: FlowTaskTypeDefinition | undefined,
): string => {
  if (task.description !== undefined) return shorten(task.description);
  switch (task.type) {
    case "if":
      return "Checks a condition";
    case "switch":
      return `Chooses one of ${"cases" in task ? task.cases.length : 0} cases`;
    case "for_each":
      return "Repeats its steps for each item";
    case "parallel":
      return "Runs its branches side by side";
    case "stop":
      return "Stops the flow";
    case "operation.call": {
      const operation = literalText(task, "operation");
      return operation === undefined
        ? (definition?.summary ?? task.type)
        : `Runs ${studioWords(operation.split(".").pop() ?? operation).toLowerCase()}`;
    }
    case "interface.navigate": {
      const page = literalText(task, "page");
      const name = source.body.pages.find((candidate) => candidate.key === page)?.name;
      return name === undefined ? "Opens a page" : `Opens ${name}`;
    }
  }
  const message = literalText(task, "message");
  if (message !== undefined) return shorten(`“${message}”`);
  return shorten(definition?.summary ?? studioWords(task.type));
};

const invalidOutline = (detail: string): never => {
  throw new TypeError(`Invalid authored flow outline: ${detail}`);
};

/** Walks the real authored lists. No graph identity, inferred branch or cosmetic order is stored. */
export const studioFlowOutline = (
  context: StudioFlowContext,
  selection: StudioFlowSelection,
): StudioFlowOutline => {
  if (!validContext(context)) return invalidOutline("the draft snapshot is not valid");
  const siblings = studioFlowCollection(context.source, selection.moduleKey);
  const matches = siblings?.filter((flow) => flow.id === selection.flowAlias) ?? [];
  const flow = matches[0];
  if (siblings === undefined || matches.length !== 1 || flow === undefined)
    return invalidOutline("the flow is not in the draft");
  const ids = new Set<string>();
  const entries: StudioFlowEntry[] = [];
  let count = 0;
  const list = (
    label: string,
    tasks: readonly SourceFlowTask[] | undefined,
    path: StudioFlowPath,
    depth: number,
  ): StudioFlowTaskListOutline => ({
    label,
    path,
    tasks: (tasks ?? []).map((task, index) => {
      if (++count > flowMaximumTaskCount) return invalidOutline("too many tasks");
      if (depth > flowMaximumTaskNestingDepth) return invalidOutline("tasks nest too deeply");
      if (ids.has(task.id)) return invalidOutline("two tasks share an id");
      ids.add(task.id);
      const taskPath = [...path, index];
      entries.push({ task, path: taskPath });
      const children: StudioFlowTaskListOutline[] = [];
      switch (task.type) {
        case "if":
          if (!("then" in task)) return invalidOutline("an If task has no Then list");
          children.push(list("Then", task.then, [...taskPath, "then"], depth + 1));
          if (task.else !== undefined)
            children.push(list("Else", task.else, [...taskPath, "else"], depth + 1));
          break;
        case "switch":
          if (!("cases" in task)) return invalidOutline("a Switch task has no cases");
          task.cases.forEach((branch, branchIndex) =>
            children.push(
              list(
                `Case ${studioWords(branch.key)}`,
                branch.tasks,
                [...taskPath, "cases", branchIndex, "tasks"],
                depth + 1,
              ),
            ),
          );
          if (task.default !== undefined)
            children.push(list("Otherwise", task.default, [...taskPath, "default"], depth + 1));
          break;
        case "for_each":
        case "sequential":
          if (!("tasks" in task)) return invalidOutline("a grouping task has no steps");
          children.push(list("Steps", task.tasks, [...taskPath, "tasks"], depth + 1));
          break;
        case "parallel":
          if (!("branches" in task)) return invalidOutline("a Parallel task has no branches");
          task.branches.forEach((branch, branchIndex) =>
            children.push(
              list(
                `Branch ${branchIndex + 1}`,
                branch,
                [...taskPath, "branches", branchIndex],
                depth + 1,
              ),
            ),
          );
          break;
      }
      const definition = studioFlowDefinitionOf(task.type);
      return {
        id: task.id,
        type: task.type,
        title: definition?.title ?? studioWords(task.type),
        caption: taskCaption(context.source, task, definition),
        path: taskPath,
        children,
      };
    }),
  });
  const lists = [
    list("Steps", flow.tasks, ["tasks"], 1),
    list("When a step fails", flow.errors, ["errors"], 1),
    list("At the end", flow.finally, ["finally"], 1),
  ];
  return { flow, siblings, lists, entries };
};

/** The task list at a path inside a flow. */
export const studioFlowListAt = (
  flow: SourceFlow,
  path: StudioFlowPath,
): SourceFlowTask[] | undefined => {
  let cursor: unknown = flow;
  for (const part of path) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string | number, unknown>)[part];
  }
  return Array.isArray(cursor) ? (cursor as SourceFlowTask[]) : undefined;
};

const ordinal = (index: number): string => `step ${index + 1}`;

/**
 * Where a path inside a flow is, in words: "Steps, step 2 (Show message), Message". The flow's own
 * declarations are named by their labels; ids and aliases never appear.
 */
export const describeStudioFlowLocation = (
  flow: SourceFlow,
  path: readonly (string | number)[],
): string => {
  const parts: string[] = [];
  let cursor: unknown = flow;
  let inProperties = false;
  for (let index = 0; index < path.length; index += 1) {
    const part = path[index]!;
    const next =
      typeof cursor === "object" && cursor !== null
        ? (cursor as Record<string | number, unknown>)[part]
        : undefined;
    if (inProperties) {
      parts.push(studioWords(String(part)));
      inProperties = false;
      cursor = next;
      continue;
    }
    if (typeof part === "number") {
      const task = next as Partial<SourceFlowTask> | undefined;
      if (
        Array.isArray(cursor) &&
        task !== undefined &&
        typeof task === "object" &&
        typeof task.type === "string"
      ) {
        const title = studioFlowDefinitionOf(task.type)?.title ?? studioWords(task.type);
        parts.push(`${ordinal(part)} (${title})`);
      } else parts.push(`entry ${part + 1}`);
    } else
      switch (part) {
        case "tasks":
          parts.push(index === 0 ? "Steps" : "its steps");
          break;
        case "errors":
          parts.push("When a step fails");
          break;
        case "finally":
          parts.push("At the end");
          break;
        case "then":
          parts.push("Then");
          break;
        case "else":
          parts.push("Else");
          break;
        case "default":
          parts.push("Otherwise");
          break;
        case "cases":
          parts.push("case");
          break;
        case "branches":
          parts.push("branch");
          break;
        case "triggers":
          parts.push("How it starts");
          break;
        case "properties":
          inProperties = true;
          break;
        case "condition":
          parts.push("Condition");
          break;
        default:
          parts.push(studioWords(part));
      }
    cursor = next;
  }
  return parts.length === 0 ? "The flow" : parts.join(", ");
};

const issueSignature = (issue: FlowValidationIssue): string =>
  `${issue.taskId ?? ""}|${issue.ruleCode}|${issue.message}`;

/** The one flow validator, on the parsed flow (defaults filled), with Run flow targets among its siblings. */
const flowIssues = (
  parsed: ApplicationSourceDocument,
  selection: StudioFlowSelection,
): FlowValidationIssue[] | undefined => {
  const siblings = studioFlowCollection(parsed, selection.moduleKey);
  const flow = siblings?.find((candidate) => candidate.id === selection.flowAlias);
  if (siblings === undefined || flow === undefined) return undefined;
  return validateFlow(flow, {
    targetFlow: (reference) =>
      siblings.find((candidate) => candidate.id === reference || candidate.key === reference),
  });
};

/**
 * Checks an edited draft with the shared limits, the source schema and the one flow validator
 * (`validateFlow`). A problem the flow already had before the edit does not block it; a new one
 * refuses the edit with where it is and why.
 */
export const validatedStudioFlowEdit = (
  candidate: ApplicationSourceDocument,
  before: Readonly<ApplicationSourceDocument>,
  selection: StudioFlowSelection,
  taskId: string,
  context: StudioFlowContext,
): StudioFlowEditResult => {
  let flow: SourceFlow;
  try {
    flow = studioFlowOutline({ ...context, source: candidate }, selection).flow;
  } catch (cause) {
    return {
      kind: "invalid",
      cause,
      reason: `This change would break the flow's limits: at most ${flowMaximumTaskCount} steps, nested at most ${flowMaximumTaskNestingDepth} deep, each with its own name.`,
    };
  }
  const parsed = applicationSourceDocumentSchema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const flowPrefix = selection.moduleKey === null ? 3 : 5;
    const inFlow =
      first !== undefined &&
      first.path.length >= flowPrefix &&
      first.path[first.path.length >= flowPrefix ? flowPrefix - 2 : 0] === "flows";
    return {
      kind: "invalid",
      cause: parsed.error,
      reason:
        first === undefined
          ? "The draft is not valid after this change."
          : inFlow
            ? `${describeStudioFlowLocation(
                flow,
                first.path.slice(flowPrefix).map((part) => part as string | number),
              )}: ${first.message}.`
            : `${first.message} (${first.path.map(String).join(", ")}).`,
    };
  }
  const previous = applicationSourceDocumentSchema.safeParse(before);
  const known = new Set(
    (previous.success ? (flowIssues(previous.data, selection) ?? []) : []).map(issueSignature),
  );
  const fresh = (flowIssues(parsed.data, selection) ?? []).filter(
    (issue) => !known.has(issueSignature(issue)),
  );
  const first = fresh[0];
  if (first !== undefined)
    return {
      kind: "invalid",
      cause: fresh,
      reason: `${describeStudioFlowLocation(flow, first.path)}: ${first.message}.`,
    };
  return { kind: "applied", source: candidate, taskId };
};

const eventWords: Readonly<Record<string, string>> = {
  action: "is used",
  row_clicked: "row is clicked",
  row_action: "row action is used",
  [recordsTableRowEditEvent]: "row is saved",
  [recordsTableInlineEditEvent]: "value is edited",
  card_moved: "card is moved",
  card_added: "card is added to a column",
  load: "loads",
  refresh: "is refreshed",
  filter_changed: "filter changes",
  search_changed: "search changes",
  sort_changed: "sort changes",
  columns_changed: "columns change",
  page_changed: "page changes",
  selection_changed: "selection changes",
  field_changed: "field changes",
  form_ready: "form is ready",
  form_reset: "form is reset",
  form_submit: "is submitted",
  tab_changed: "tab changes",
  row_expanded: "row is expanded",

  guided_step_changed: "step changes",
};

const operationWords: Readonly<Record<string, string>> = {
  create: "created",
  update: "changed",
  transition: "moved on",
};

const recordWords = (recordTypeId: string): string =>
  studioWords(recordTypeId.split(":").pop() ?? recordTypeId).toLowerCase();
/** "a company", "an item". */
const aRecord = (recordTypeId: string): string => {
  const words = recordWords(recordTypeId);
  return `${/^[aeiou]/.test(words) ? "an" : "a"} ${words}`;
};

/**
 * How a flow starts, in words: one entry per trigger it declares and per control event bound to it.
 * `controlLabel` names a placed control the way the rest of Studio does ("Button: Mark won").
 */
export const describeStudioFlowStarts = (
  source: Readonly<ApplicationSourceDocument>,
  selection: StudioFlowSelection,
  controlLabel: (alias: string) => string,
): string[] => {
  const flow = studioFlowCollection(source, selection.moduleKey)?.find(
    (candidate) => candidate.id === selection.flowAlias,
  );
  if (flow === undefined) return [];
  const triggers = (flow.triggers ?? []).map((trigger): string => {
    switch (trigger.type) {
      case "BeforeSave":
        return `Before ${aRecord(trigger.recordTypeId)} is ${trigger.operations
          .map((operation) => operationWords[operation.kind] ?? operation.kind)
          .join(" or ")}`;
      case "Event":
        return `After ${aRecord(trigger.recordTypeId)} is ${
          trigger.event.kind === "standard"
            ? studioWords(trigger.event.eventKind).toLowerCase()
            : studioWords(trigger.event.eventKey.split(".").pop() ?? "").toLowerCase()
        }`;
      case "Schedule":
        return "On a schedule";
      case "IncomingMessage":
        return "When a message arrives";
    }
  });
  const bindings =
    selection.moduleKey !== null
      ? []
      : source.body.flow_bindings
          .filter((binding) => binding.flow === flow.id || binding.flow === flow.key)
          .map(
            (binding) =>
              `When ${controlLabel(binding.control)} ${eventWords[binding.event] ?? "is used"}`,
          );
  return [...triggers, ...bindings];
};
