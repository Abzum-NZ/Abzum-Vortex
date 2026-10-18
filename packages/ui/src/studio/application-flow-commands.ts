import {
  builderKeySchema,
  flowMaximumTaskCount,
  flowTaskRegistry,
  parseFlowReference,
  sourceFlowTaskSchema,
  validateFlowTaskPlacement,
  type ApplicationSourceDocument,
  type FlowTaskPropertyType,
  type FlowTaskTypeDefinition,
  type FlowValue,
  type SourceFlow,
  type SourceFlowTask,
} from "@vortex/platform/schema";
import type { StudioSemanticSelection } from "./semantic-selection";
import {
  sameStudioFlowContext,
  samePath,
  studioFlowDefinitionOf,
  studioFlowListAt,
  studioFlowOutline,
  validatedStudioFlowEdit,
  type StudioFlowContext,
  type StudioFlowEditResult,
  type StudioFlowPath,
  type StudioFlowSelection,
  type StudioFlowTaskListOutline,
} from "./application-flow-model";
import {
  projectStudioFlowDraftChoices,
  applyStudioFlowStepDraft,
  type StudioFlowStepDraft,
} from "./application-flow-step-form";

/**
 * The flow commands: one checked edit of the stored flow definition each, taken by the draft
 * history through the one apply function. Insert, remove, move and add a branch change the task
 * lists; set a step writes one step's whole settings form back. Every result is checked by
 * `validatedStudioFlowEdit` (limits, source schema, the one flow validator).
 */

export type StudioFlowCommand =
  | Readonly<{
      kind: "insert_task";
      taskType: string;
      formAlias?: string;
      listPath: StudioFlowPath;
      index: number;
    }>
  | Readonly<{ kind: "remove_task"; taskId: string; taskPath: StudioFlowPath }>
  | Readonly<{
      kind: "move_task";
      taskId: string;
      taskPath: StudioFlowPath;
      direction: "up" | "down";
    }>
  /** Adds the branch a decision is missing (Else, Otherwise) or another parallel branch, starting with one step. */
  | Readonly<{
      kind: "add_branch";
      taskId: string;
      taskPath: StudioFlowPath;
      taskType: string;
      formAlias?: string;
    }>
  /** Writes one step's settings form (its description, settings and control shape) back to the step. */
  | Readonly<{
      kind: "set_step";
      taskId: string;
      taskPath: StudioFlowPath;
      draft: StudioFlowStepDraft;
    }>;

type RegisteredTask = Extract<SourceFlowTask, { properties: unknown }>;

const staleEdit = (
  reason = "The draft or the selected step changed. Select the step again and retry.",
): StudioFlowEditResult => ({ kind: "stale", reason });

// ─── Inserting: steps seeded from the registry and the draft ─────────────────────────────────

const text = (value: string): FlowValue => ({ kind: "literal", literal: { type: "text", value } });

/**
 * The first valid value of a required setting, read from the draft where it points at something
 * (the first record type, page, action or query), or undefined when there is none.
 */
const seedValue = (
  type: FlowTaskPropertyType,
  flow: SourceFlow,
  source: Readonly<ApplicationSourceDocument>,
  context: StudioFlowContext,
): FlowValue | undefined => {
  const modules = source.body.modules;
  const recordInput =
    flow.recordInput ??
    Object.entries(flow.inputs ?? {}).find(([, input]) => input.type === "record_reference")?.[0];
  const recordType =
    (recordInput === undefined ? undefined : flow.inputs?.[recordInput]?.recordTypeIds?.[0]) ??
    (flow.triggers ?? []).flatMap((trigger) =>
      "recordTypeId" in trigger ? [trigger.recordTypeId] : [],
    )[0];
  switch (type) {
    case "form_id": {
      const form = projectStudioFlowDraftChoices({
        ...context,
        source: source as ApplicationSourceDocument,
      flow,
      }).forms[0];
      return form === undefined ? undefined : text(form.alias);
    }
    case "namespaced_key": {
      const event = source.body.modules
        .flatMap((module) =>
          module.events.map((event) => ({
            event,
            recordType: `${module.key}:${event.record_type}`,
          })),
        )
        .find(
          (entry) =>
            recordType === undefined ||
            entry.recordType === recordType ||
            entry.event.record_type === recordType,
        );
      return event === undefined ? undefined : text(event.event.key);
    }
    case "record_reference": {
      return recordInput === undefined
        ? undefined
        : { kind: "reference", reference: { source: "input", name: recordInput } };
    }
    case "record_change_list": {
      const input = Object.entries(flow.inputs ?? {}).find(([, input]) => input.type === "json");
      return input === undefined
        ? undefined
        : { kind: "reference", reference: { source: "input", name: input[0] } };
    }
    case "message_text":
      return text("Edit this message");
    case "formula":
      return {
        kind: "formula",
        formula: {
          op: "add",
          args: [
            { op: "literal", type: "whole_number", value: 0 },
            { op: "literal", type: "whole_number", value: 0 },
          ],
          scale: 0,
          rounding: "half_up",
        },
      };
    case "record_type_id": {
      if (recordType !== undefined) return text(recordType);
      const module = modules.find((candidate) => candidate.record_types.length > 0);
      return module === undefined
        ? undefined
        : text(`${module.key}:${module.record_types[0]!.key}`);
    }
    case "page_id":
      return source.body.pages[0] === undefined ? undefined : text(source.body.pages[0].key);
    case "protected_operation_key": {
      const action = modules.flatMap((module) => module.actions)[0];
      return action === undefined ? undefined : text(action.key);
    }
    case "query_id": {
      const module = modules.find((candidate) => candidate.queries.length > 0);
      return module === undefined ? undefined : text(`${module.key}:${module.queries[0]!.key}`);
    }
    case "field_values": {
      const formAnswers = Object.entries(flow.inputs ?? {}).find(
        ([, declaration]) => declaration.type === "json",
      )?.[0];
      return formAnswers === undefined
        ? { kind: "map", entries: {} }
        : { kind: "reference", reference: { source: "input", name: formAnswers } };
    }
    case "field_id": {
      // A save rule names a field of the record it runs for, as `<record type>.<field>`: its title field first.
      const recordTypeId = (flow.triggers ?? []).flatMap((trigger) =>
        trigger.type === "BeforeSave" ? [trigger.recordTypeId] : [],
      )[0];
      if (recordTypeId === undefined) return undefined;
      const owner = modules.find((module) =>
        module.flows.some((candidate) => candidate.id === flow.id),
      );
      const record = owner?.record_types.find((candidate) => candidate.key === recordTypeId);
      const field =
        record?.fields.find((candidate) => candidate.key === record.title_field) ??
        record?.fields[0];
      return field === undefined ? undefined : text(`${recordTypeId}.${field.key}`);
    }
    default:
      return undefined;
  }
};

/** The reason key a new Refuse save step starts with; the builder words its message. */
const refusalReasonSeed = text("save_refused");

const seededTask = (
  definition: FlowTaskTypeDefinition,
  id: string,
  flow: SourceFlow,
  source: Readonly<ApplicationSourceDocument>,
  context: StudioFlowContext,
): RegisteredTask | undefined => {
  const properties: RegisteredTask["properties"] = {};
  for (const [key, declaration] of Object.entries(definition.properties)) {
    if (!declaration.required) continue;
    const seed =
      definition.type === "rule.refuse" && key === "reason"
        ? refusalReasonSeed
        : seedValue(declaration.type, flow, source, context);
    if (seed === undefined) return undefined;
    properties[key] = seed;
  }
  return { id, type: definition.type, version: definition.version, properties };
};

/** The registry's own placement rule for a flow of this execution kind holding these tasks. */
const placementIssues = (flow: SourceFlow, tasks: readonly SourceFlowTask[]): string[] =>
  validateFlowTaskPlacement({ ...flow, tasks: [...tasks] } as Parameters<
    typeof validateFlowTaskPlacement
  >[0]).map((issue) => issue.message);

export type StudioFlowStepType = Readonly<{ type: string; title: string; summary: string }>;

/** The control steps a person adds from the palette: a decision and an early end. */
const paletteControls = ["if", "stop"] as const;

/** Registered step types the flow's execution kind accepts and that can start from seeds. */
const registeredTypes = (
  flow: SourceFlow,
  source: Readonly<ApplicationSourceDocument>,
  context: StudioFlowContext,
): FlowTaskTypeDefinition[] =>
  Object.values(flowTaskRegistry).filter((definition) => {
    if (definition.category !== "registered") return false;
    const task = seededTask(definition, "probe", flow, source, context);
    return (
      task !== undefined &&
      sourceFlowTaskSchema.safeParse(task).success &&
      placementIssues({ ...flow, errors: [], finally: [] }, [task]).length === 0
    );
  });

const stepTypes = (
  flow: SourceFlow,
  source: Readonly<ApplicationSourceDocument>,
  context: StudioFlowContext,
): readonly StudioFlowStepType[] => {
  const registered = registeredTypes(flow, source, context);
  const controls =
    registered.length === 0 ? [] : paletteControls.map((type) => flowTaskRegistry[type]);
  return [...registered, ...controls].map((definition) => ({
    type: definition.type,
    title: definition.title,
    summary: definition.summary,
  }));
};

const uniqueTaskId = (type: string, used: Set<string>): string => {
  const base = (type.split(".").pop() ?? type).replace(/[^a-z0-9_]/g, "_");
  let candidate = base;
  for (let n = 2; used.has(candidate); n += 1) candidate = `${base}_${n}`;
  used.add(candidate);
  return candidate;
};

/** A new step of a type; a decision starts with one step in its Then branch and always holds until its condition is set. */
const newStep = (
  flow: SourceFlow,
  source: Readonly<ApplicationSourceDocument>,
  taskType: string,
  used: Set<string>,
  context: StudioFlowContext,
  formAlias?: string,
): SourceFlowTask | StudioFlowEditResult => {
  const refused: StudioFlowEditResult = {
    kind: "unsupported",
    reason:
      "This flow cannot run that kind of step, or the step needs settings this application does not have yet.",
  };
  if (!stepTypes(flow, source, context).some((entry) => entry.type === taskType)) return refused;
  if (taskType === "stop")
    return { id: uniqueTaskId("stop", used), type: "stop", outcome: "stopped" };
  if (taskType === "if") {
    const types = registeredTypes(flow, source, context);
    const first =
      types.find(
        (definition) =>
          definition.type === "interface.show_message" || definition.type === "rule.warn",
      ) ?? types[0];
    const inner =
      first === undefined
        ? undefined
        : seededTask(first, uniqueTaskId(first.type, used), flow, source, context);
    if (inner === undefined) return refused;
    return {
      id: uniqueTaskId("decision", used),
      type: "if",
      condition: { op: "literal", type: "yes_no", value: true },
      then: [inner],
    };
  }
  const definition = studioFlowDefinitionOf(taskType);
  const task =
    definition === undefined
      ? undefined
      : seededTask(definition, uniqueTaskId(definition.type, used), flow, source, context);
  if (task?.type === "interface.show_form" && formAlias !== undefined) {
    const form = projectStudioFlowDraftChoices({
      ...context,
      source: source as ApplicationSourceDocument,
      flow,
    }).forms.find((entry) => entry.alias === formAlias);
    if (form === undefined) return refused;
    task.properties.form = text(formAlias);
    task.properties.inputs = {
      kind: "map",
      entries: Object.fromEntries(
        form.fields.map((field) => [field.name, field.initialValue ?? text("")]),
      ),
    };
  }
  return task ?? refused;
};

// ─── Step actions: what the inspector offers for one step ────────────────────────────────────

export type StudioFlowStepActions = Readonly<{
  /** Step types that can be added to this flow. */
  stepTypes: readonly StudioFlowStepType[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** The branch Add branch would create, or null when this step has none to add. */
  branch: string | null;
}>;

export const projectStudioFlowStepActions = (
  context: StudioFlowContext,
  selection: StudioFlowSelection,
  taskPath: StudioFlowPath | null,
): StudioFlowStepActions => {
  try {
    const current = studioFlowOutline(context, selection);
    const types =
      current.entries.length < flowMaximumTaskCount
        ? stepTypes(current.flow, context.source, context)
        : [];
    if (taskPath === null)
      return { stepTypes: types, canMoveUp: false, canMoveDown: false, branch: null };
    const index = taskPath[taskPath.length - 1];
    const list = studioFlowListAt(current.flow, taskPath.slice(0, -1));
    const task = typeof index === "number" ? list?.[index] : undefined;
    const branch =
      task === undefined
        ? null
        : task.type === "if" && "then" in task && task.else === undefined
          ? "Else"
          : task.type === "switch" && "cases" in task && task.default === undefined
            ? "Otherwise"
            : task.type === "parallel" && "branches" in task
              ? `Branch ${task.branches.length + 1}`
              : null;
    return {
      stepTypes: types,
      canMoveUp: typeof index === "number" && index > 0,
      canMoveDown: typeof index === "number" && list !== undefined && index < list.length - 1,
      branch,
    };
  } catch {
    return { stepTypes: [], canMoveUp: false, canMoveDown: false, branch: null };
  }
};

/** The step types for a flow, or why none could be worked out. */
export const projectStudioFlowStepTypes = (
  context: StudioFlowContext,
  selection: StudioFlowSelection,
): readonly StudioFlowStepType[] =>
  projectStudioFlowStepActions(context, selection, null).stepTypes;

// ─── Removing ────────────────────────────────────────────────────────────────────────────────

/** Refuse retained references; never turn deletion into an implicit reference repair. */
const hasRetainedTaskReference = (
  source: Readonly<ApplicationSourceDocument>,
  taskId: string,
): boolean => {
  const pending: unknown[] = [source];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      const reference = parseFlowReference(value);
      if (reference?.source === "task_output" && reference.task === taskId) return true;
    } else if (typeof value === "object" && value !== null) {
      if (seen.has(value)) continue;
      seen.add(value);
      if (
        ("source" in value &&
          value.source === "task_output" &&
          "task" in value &&
          value.task === taskId) ||
        ("kind" in value && value.kind === "flow_node" && "key" in value && value.key === taskId)
      )
        return true;
      pending.push(...Object.values(value));
    }
  }
  return false;
};

// ─── The one apply function ──────────────────────────────────────────────────────────────────

const commandTask = (
  lists: readonly StudioFlowTaskListOutline[],
  id: string,
  path: StudioFlowPath,
): string | undefined => {
  for (const list of lists)
    for (const task of list.tasks) {
      if (task.id === id && samePath(task.path, path)) return task.title;
      const child = commandTask(task.children, id, path);
      if (child !== undefined) return child;
    }
  return undefined;
};

/** Applies one flow command to a detached copy of the current draft and checks the result. */
export const applyStudioFlowCommand = (
  current: StudioFlowContext,
  expected: StudioFlowContext,
  selection: StudioSemanticSelection | null,
  expectedSelection: StudioFlowSelection,
  command: StudioFlowCommand,
): StudioFlowEditResult => {
  if (!sameStudioFlowContext(current, expected, selection, expectedSelection)) return staleEdit();
  try {
    const original = studioFlowOutline(current, expectedSelection);
    const used = new Set(original.entries.map((entry) => entry.task.id));
    const candidate: ApplicationSourceDocument = structuredClone(current.source);
    const detached = studioFlowOutline({ ...current, source: candidate }, expectedSelection).flow;
    const done = (taskId: string) =>
      validatedStudioFlowEdit(candidate, current.source, expectedSelection, taskId, current);
    const full =
      original.entries.length >= flowMaximumTaskCount
        ? {
            kind: "invalid" as const,
            reason: `A flow can hold at most ${flowMaximumTaskCount} steps, nested steps included.`,
          }
        : undefined;

    if (command.kind === "insert_task") {
      const target = studioFlowListAt(detached, command.listPath);
      if (
        target === undefined ||
        !Number.isInteger(command.index) ||
        command.index < 0 ||
        command.index > target.length
      )
        return staleEdit("That place in the flow changed. Select a step again and retry.");
      if (full !== undefined) return full;
      const task = newStep(
        original.flow,
        current.source,
        command.taskType,
        used,
        current,
        command.formAlias,
      );
      if ("kind" in task && !("id" in task)) return task;
      target.splice(command.index, 0, task as SourceFlowTask);
      return done((task as SourceFlowTask).id);
    }

    if (
      !builderKeySchema.safeParse(command.taskId).success ||
      commandTask(original.lists, command.taskId, command.taskPath) === undefined
    )
      return staleEdit("That step is no longer in the draft. Select it again.");
    const index = command.taskPath[command.taskPath.length - 1];
    const parentPath = command.taskPath.slice(0, -1);
    const list = studioFlowListAt(detached, parentPath);
    if (typeof index !== "number" || list?.[index]?.id !== command.taskId) return staleEdit();

    switch (command.kind) {
      case "remove_task": {
        if (list.length === 1 && parentPath[0] !== "errors" && parentPath[0] !== "finally")
          return {
            kind: "unsupported",
            reason:
              parentPath.length === 1
                ? "A flow keeps at least one step. Add another step first, then remove this one."
                : "A branch keeps at least one step. Remove the step that owns the branch instead.",
          };
        const removed = original.entries
          .filter(
            ({ path }) =>
              path.length >= command.taskPath.length &&
              samePath(path.slice(0, command.taskPath.length), command.taskPath),
          )
          .map(({ task }) => task.id);
        list.splice(index, 1);
        const referenced = removed.find((id) => hasRetainedTaskReference(candidate, id));
        if (referenced !== undefined)
          return {
            kind: "unsupported",
            reason:
              "Another step or part of the application still reads the result of this step. Change that first.",
          };
        return done(command.taskId);
      }
      case "move_task": {
        const to = index + (command.direction === "up" ? -1 : 1);
        if (to < 0 || to >= list.length)
          return {
            kind: "invalid",
            reason:
              command.direction === "up"
                ? "This step is already first in its list."
                : "This step is already last in its list.",
          };
        const [moved] = list.splice(index, 1);
        list.splice(to, 0, moved!);
        return done(command.taskId);
      }
      case "add_branch": {
        if (full !== undefined) return full;
        const task = newStep(
          original.flow,
          current.source,
          command.taskType,
          used,
          current,
          command.formAlias,
        );
        if ("kind" in task && !("id" in task)) return task;
        const owner = list[index]!;
        if (owner.type === "if" && "then" in owner && owner.else === undefined)
          owner.else = [task as SourceFlowTask];
        else if (owner.type === "switch" && "cases" in owner && owner.default === undefined)
          owner.default = [task as SourceFlowTask];
        else if (owner.type === "parallel" && "branches" in owner)
          owner.branches.push([task as SourceFlowTask]);
        else
          return {
            kind: "unsupported",
            reason:
              "This step has no branch to add. Only a decision without Else or Otherwise, or a parallel step, can get one.",
          };
        return done((task as SourceFlowTask).id);
      }
      case "set_step": {
        const built = applyStudioFlowStepDraft(
          current.source,
          original.flow,
          expectedSelection.moduleKey,
          list[index]!,
          command.taskPath,
          command.draft,
        );
        if (!built.ok) return { kind: "invalid", reason: built.reason };
        // Settings that come out as the step already has them apply as no change.
        list[index] = built.value;
        return done(command.taskId);
      }
    }
  } catch (cause) {
    return { kind: "invalid", cause, reason: "The draft could not be read to make this change." };
  }
};
