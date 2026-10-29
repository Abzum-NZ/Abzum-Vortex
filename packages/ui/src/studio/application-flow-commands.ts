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
  type FlowFormula,
  type SourceFlow,
  type SourceFlowTask,
} from "@vortex/platform/schema";
import type { StudioSemanticSelection } from "./semantic-selection";
import {
  sameStudioFlowContext,
  samePath,
  studioWords,
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
import { studioFlowEventChoices } from "./application-flow-values";
import {
  addStudioFlowShownForm,
  studioFlowCanCreateShownForm,
} from "./application-flow-shown-form";
import { studioFlowLabel } from "./semantic-selection";

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
      settings: StudioFlowNewStepSettings;
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
  /** Adds the branch a decision is missing (Else, Otherwise), starting with one step. */
  | Readonly<{
      kind: "add_branch";
      taskId: string;
      taskPath: StudioFlowPath;
      taskType: string;
      settings: StudioFlowNewStepSettings;
    }>
  /** Writes one step's settings form (its description, settings and control shape) back to the step. */
  | Readonly<{
      kind: "set_step";
      taskId: string;
      taskPath: StudioFlowPath;
      draft: StudioFlowStepDraft;
    }>;

type RegisteredTask = Extract<SourceFlowTask, { properties: unknown }>;

/** Required choices are authored before a new step enters the saved draft. */
export type StudioFlowNewStepSettings = Readonly<{
  /** The builder's pick for each required reference setting of the step, by property key. */
  choices?: Readonly<Record<string, string>>;
  message?: string;
  field?: string;
  condition?: FlowFormula;
  thenTaskType?: string;
}>;

const staleEdit = (
  reason = "The draft or the selected step changed. Select the step again and retry.",
): StudioFlowEditResult => ({ kind: "stale", reason });

// ─── Inserting: steps seeded from the registry and the draft ─────────────────────────────────

const text = (value: string): FlowValue => ({ kind: "literal", literal: { type: "text", value } });

/** The record input the flow runs for: the one it names, or its first record reference input. */
const flowRecordInput = (flow: SourceFlow): string | undefined =>
  flow.recordInput ??
  Object.entries(flow.inputs ?? {}).find(([, input]) => input.type === "record_reference")?.[0];

/** The record type the flow itself runs for (its record input or its trigger), when it has one. */
const flowRecordType = (flow: SourceFlow): string | undefined => {
  const recordInput = flowRecordInput(flow);
  return (
    (recordInput === undefined ? undefined : flow.inputs?.[recordInput]?.recordTypeIds?.at(0)) ??
    (flow.triggers ?? [])
      .flatMap((trigger) => ("recordTypeId" in trigger ? [trigger.recordTypeId] : []))
      .at(0)
  );
};

/**
 * The pick that asks for a new form on the page of the flow's button instead of an existing one.
 * It is not a valid block name, so no form can be named like it.
 */
export const studioNewFormChoice = "+new_form";

/** One builder decision a step needs before it is inserted: what the setting points at. */
export type StudioFlowStepBuilderChoice = Readonly<{
  property: string;
  label: string;
  unset: string;
  options: readonly Readonly<{ value: string; label: string }>[];
}>;

const builderChoiceLabels: Readonly<Record<string, readonly [label: string, unset: string]>> = {
  form: ["Form to show", "Choose a form before adding the step"],
  operation: ["Operation to call", "Choose an operation before adding the step"],
  page: ["Page to open", "Choose a page before adding the step"],
  query: ["Query to read", "Choose a query before adding the step"],
  record_type: ["Record type", "Choose a record type before adding the step"],
  event: ["Event to announce", "Choose an event before adding the step"],
};

/**
 * What a required setting points at when only the builder can decide it: the forms, operations,
 * pages, queries, record types or events of the draft. Undefined for a setting the flow itself
 * decides (a record type the flow already runs for, a value, a message).
 */
const builderChoiceOptions = (
  type: FlowTaskPropertyType,
  flow: SourceFlow,
  source: Readonly<ApplicationSourceDocument>,
  context: StudioFlowContext,
): StudioFlowStepBuilderChoice["options"] | undefined => {
  const draft = () =>
    projectStudioFlowDraftChoices({
      ...context,
      source: source as ApplicationSourceDocument,
      flow,
    });
  switch (type) {
    case "form_id": {
      const forms = draft().forms.map((form) => ({ value: form.alias, label: form.label }));
      return studioFlowCanCreateShownForm(
        context.catalogue,
        source as ApplicationSourceDocument,
        flow,
      )
        ? [...forms, { value: studioNewFormChoice, label: "Create a form for this step" }]
        : forms;
    }
    case "protected_operation_key":
      return draft().actions.map((action) => ({ value: action.key, label: action.label }));
    case "page_id":
      return draft().pages.map((page) => ({ value: page.key, label: page.label }));
    case "query_id":
      return draft().queries.map((query) => ({ value: query.key, label: query.label }));
    case "record_type_id":
      return flowRecordType(flow) === undefined
        ? draft().recordTypes.map((record) => ({ value: record.key, label: record.label }))
        : undefined;
    case "namespaced_key": {
      const moduleKey =
        source.body.modules.find((module) =>
          module.flows.some((candidate) => candidate.id === flow.id),
        )?.key ?? null;
      return studioFlowEventChoices(source, flow, moduleKey);
    }
    default:
      return undefined;
  }
};

/** The value of a required setting the flow decides itself, or undefined when it has none. */
const seedValue = (
  type: FlowTaskPropertyType,
  flow: SourceFlow,
  source: Readonly<ApplicationSourceDocument>,
): FlowValue | undefined => {
  const modules = source.body.modules;
  const recordInput = flowRecordInput(flow);
  const recordType = flowRecordType(flow);
  switch (type) {
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
      return text("");
    case "formula":
      return {
        kind: "formula",
        formula: {
          op: "add",
          args: [
            { op: "literal", type: "whole_number", value: 0 },
            { op: "literal", type: "whole_number", value: 0 },
          ],
        },
      };
    case "record_type_id":
      return recordType === undefined ? undefined : text(recordType);
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

/** The builder decisions a step type needs before it is inserted, with what each can point at. */
const stepBuilderChoices = (
  definition: FlowTaskTypeDefinition,
  flow: SourceFlow,
  source: Readonly<ApplicationSourceDocument>,
  context: StudioFlowContext,
): StudioFlowStepBuilderChoice[] =>
  Object.entries(definition.properties).flatMap(([property, declaration]) => {
    if (!declaration.required) return [];
    const options = builderChoiceOptions(declaration.type, flow, source, context);
    const [label, unset] = builderChoiceLabels[property] ?? [
      studioWords(property),
      `Choose ${studioWords(property).toLowerCase()} before adding the step`,
    ];
    return options === undefined ? [] : [{ property, label, unset, options }];
  });

/**
 * A step with its required settings: the flow's own values, and the builder's pick for every
 * setting only the builder can decide. Undefined when a pick is missing or no choice exists.
 */
const seededTask = (
  definition: FlowTaskTypeDefinition,
  id: string,
  flow: SourceFlow,
  source: Readonly<ApplicationSourceDocument>,
  choices: readonly StudioFlowStepBuilderChoice[],
  picks: Readonly<Record<string, string>>,
): RegisteredTask | undefined => {
  const properties: RegisteredTask["properties"] = {};
  for (const [key, declaration] of Object.entries(definition.properties)) {
    if (!declaration.required) continue;
    const choice = choices.find((entry) => entry.property === key);
    const pick = picks[key];
    if (choice !== undefined) {
      if (pick === undefined || !choice.options.some((option) => option.value === pick))
        return undefined;
      properties[key] = text(pick);
      continue;
    }
    const seed =
      definition.type === "rule.refuse" && key === "reason"
        ? refusalReasonSeed
        : definition.type === "interface.show_message" && key === "target"
          ? // The page shows messages in a dialog today.
            text("dialog")
          : definition.type === "interface.show_message" && key === "severity"
            ? text("info")
            : definition.type === "data.calculate" && key === "result_type"
              ? text("decimal_number")
              : seedValue(declaration.type, flow, source);
    if (seed === undefined) return undefined;
    properties[key] = seed;
  }
  // A dialog is headed by what the person was doing: the flow's name.
  if (definition.type === "interface.show_message")
    properties.title = text(flow.labels?.name ?? "");
  if (definition.type === "data.calculate") {
    properties.formula = {
      kind: "formula",
      formula: { op: "literal", type: "decimal_number", value: "0" },
    };
    properties.places = { kind: "literal", literal: { type: "whole_number", value: 2 } };
    properties.rounding = text("half_up");
  }
  return { id, type: definition.type, version: definition.version, properties };
};

/**
 * The inputs of a Call protected operation step: always an explicit map, so the step passes
 * nothing the builder did not map. The flow's record goes to the operation's record input only
 * when the operation declares one for the record type the flow runs for.
 */
export const studioOperationCallProperties = (
  flow: SourceFlow,
  operation: Readonly<{
    key: string;
    inputs: readonly Readonly<{ key: string; type: string; record_types?: readonly string[] }>[];
  }>,
): RegisteredTask["properties"] => {
  const recordInput = flowRecordInput(flow);
  const flowRecordTypes =
    recordInput === undefined ? [] : (flow.inputs?.[recordInput]?.recordTypeIds ?? []);
  const target = operation.inputs.find(
    (input) =>
      input.type === "record_reference" &&
      (input.record_types ?? []).some((type) => flowRecordTypes.includes(type)),
  );
  return {
    operation: text(operation.key),
    inputs: {
      kind: "map",
      entries:
        target === undefined || recordInput === undefined
          ? {}
          : {
              [target.key]: {
                kind: "reference",
                reference: { source: "input", name: recordInput },
              },
            },
    },
  };
};

/** The registry's own placement rule for a flow of this execution kind holding these tasks. */
const placementIssues = (flow: SourceFlow, tasks: readonly SourceFlowTask[]): string[] =>
  validateFlowTaskPlacement({ ...flow, tasks: [...tasks] } as Parameters<
    typeof validateFlowTaskPlacement
  >[0]).map((issue) => issue.message);

export type StudioFlowStepType = Readonly<{
  type: string;
  title: string;
  summary: string;
  /** What the builder decides before the step is inserted; the palette asks for each first. */
  choices: readonly StudioFlowStepBuilderChoice[];
}>;

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
    const choices = stepBuilderChoices(definition, flow, source, context);
    // The type is offered when each decision has at least one option; the probe only proves the
    // step would be valid, and is never inserted.
    const probe = Object.fromEntries(
      choices.flatMap((choice) => {
        const option = choice.options.at(0);
        return option === undefined ? [] : [[choice.property, option.value]];
      }),
    );
    const task = seededTask(definition, "probe", flow, source, choices, probe);
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
    choices:
      definition.category === "registered"
        ? stepBuilderChoices(definition, flow, source, context)
        : [],
  }));
};

const uniqueTaskId = (type: string, used: Set<string>): string => {
  const base = (type.split(".").pop() ?? type).replace(/[^a-z0-9_]/g, "_");
  let candidate = base;
  for (let n = 2; used.has(candidate); n += 1) candidate = `${base}_${n}`;
  used.add(candidate);
  return candidate;
};

/** A new step of a type, with required decisions made explicitly by the author. */
const newStep = (
  flow: SourceFlow,
  source: Readonly<ApplicationSourceDocument>,
  taskType: string,
  used: Set<string>,
  context: StudioFlowContext,
  settings: StudioFlowNewStepSettings,
): SourceFlowTask | StudioFlowEditResult => {
  const refused: StudioFlowEditResult = {
    kind: "unsupported",
    reason:
      "This flow cannot run that kind of step, or the step needs settings this application does not have yet.",
  };
  const offered = stepTypes(flow, source, context).find((entry) => entry.type === taskType);
  if (offered === undefined) return refused;
  const picks = settings.choices ?? {};
  const unpicked = offered.choices.find(
    (choice) => !choice.options.some((option) => option.value === picks[choice.property]),
  );
  if (unpicked !== undefined) return { kind: "invalid", reason: `${unpicked.unset}.` };
  const definition = studioFlowDefinitionOf(taskType);
  const needsMessage = definition?.properties.message?.required === true;
  if (needsMessage && !settings.message?.trim())
    return { kind: "invalid", reason: "Write the message before adding this step." };
  if (taskType === "rule.require" && !settings.field)
    return { kind: "invalid", reason: "Choose the field before adding this step." };
  if (taskType === "stop")
    return { id: uniqueTaskId("stop", used), type: "stop", outcome: "stopped" };
  if (taskType === "if") {
    if (settings.condition === undefined || settings.condition.op === "literal")
      return { kind: "invalid", reason: "Set a comparison before adding an If step." };
    if (!["rule.warn", "interface.show_message", "stop"].includes(settings.thenTaskType ?? ""))
      return { kind: "invalid", reason: "Choose the first step of the Then branch." };
    const inner = newStep(flow, source, settings.thenTaskType!, used, context, settings);
    if ("kind" in inner && !("id" in inner)) return inner;
    return {
      id: uniqueTaskId("decision", used),
      type: "if",
      condition: settings.condition,
      then: [inner as SourceFlowTask],
    };
  }
  const task =
    definition === undefined
      ? undefined
      : seededTask(
          definition,
          uniqueTaskId(definition.type, used),
          flow,
          source,
          offered.choices,
          picks,
        );
  if (task !== undefined && settings.message !== undefined)
    task.properties.message = text(settings.message.trim());
  if (task?.type === "rule.require" && settings.field !== undefined)
    task.properties.field = text(settings.field);
  if (task?.type === "operation.call") {
    const operation = source.body.modules
      .flatMap((module) => module.actions)
      .find((entry) => entry.key === picks.operation);
    if (operation === undefined) return refused;
    task.properties = studioOperationCallProperties(flow, operation);
  }
  if (task?.type === "interface.show_form") {
    const form = projectStudioFlowDraftChoices({
      ...context,
      source: source as ApplicationSourceDocument,
      flow,
    }).forms.find((entry) => entry.alias === picks.form);
    if (form === undefined) return refused;
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
            : null;
    return {
      stepTypes: types,
      canMoveUp: typeof index === "number" && index > 0,
      canMoveDown: typeof index === "number" && list !== undefined && index < list.length - 1,
      branch,
    };
  } catch (error) {
    console.error("[studio-flow] step actions unavailable", error);
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
const hasRetainedTaskReference = (flow: Readonly<SourceFlow>, taskId: string): boolean => {
  const pending: unknown[] = [flow];
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

    /** A Show form step that asks for a new form gets it on the page of the flow's button first. */
    const stepInputs = (taskType: string, settings: StudioFlowNewStepSettings) => {
      if (taskType !== "interface.show_form" || settings.choices?.form !== studioNewFormChoice)
        return { source: current.source, settings };
      const added = addStudioFlowShownForm(
        current.catalogue,
        candidate,
        original.flow,
        studioFlowLabel(original.flow),
      );
      if (!added.ok) return { refused: { kind: "invalid", reason: added.reason } as const };
      return {
        source: candidate as Readonly<ApplicationSourceDocument>,
        settings: { ...settings, choices: { ...settings.choices, form: added.alias } },
      };
    };

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
      const inputs = stepInputs(command.taskType, command.settings);
      if ("refused" in inputs) return inputs.refused;
      const task = newStep(
        original.flow,
        inputs.source,
        command.taskType,
        used,
        current,
        inputs.settings,
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
        const referenced = removed.find((id) => hasRetainedTaskReference(detached, id));
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
        const inputs = stepInputs(command.taskType, command.settings);
        if ("refused" in inputs) return inputs.refused;
        const task = newStep(
          original.flow,
          inputs.source,
          command.taskType,
          used,
          current,
          inputs.settings,
        );
        if ("kind" in task && !("id" in task)) return task;
        const owner = list[index]!;
        if (owner.type === "if" && "then" in owner && owner.else === undefined)
          owner.else = [task as SourceFlowTask];
        else if (owner.type === "switch" && "cases" in owner && owner.default === undefined)
          owner.default = [task as SourceFlowTask];
        else
          return {
            kind: "unsupported",
            reason:
              "This step has no branch to add. Only a decision without Else or Otherwise can get one.",
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
