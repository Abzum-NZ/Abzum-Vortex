import {
  builderKeySchema,
  flowFormulaSchema,
  flowLiteralSchema,
  flowMaximumTaskCount,
  flowRoundingModeSchema,
  flowTaskRegistry,
  namespacedKeySchema,
  parseFlowReference,
  sourceFlowTaskSchema,
  validateFlowTaskPlacement,
  type ApplicationSourceDocument,
  type FlowFormula,
  type FlowRoundingMode,
  type FlowTaskPropertyType,
  type FlowTaskTypeDefinition,
  type SourceFlow,
  type SourceFlowTask,
} from "@vortex/platform/schema";
import type { StudioSemanticSelection } from "./semantic-selection";
import {
  describeStudioFlowLocation,
  sameStudioFlowContext,
  samePath,
  studioFlowDefinitionOf,
  studioFlowListAt,
  studioFlowOutline,
  studioWords,
  validatedStudioFlowEdit,
  type StudioFlowContext,
  type StudioFlowEditResult,
  type StudioFlowPath,
  type StudioFlowSelection,
  type StudioFlowTaskListOutline,
} from "./application-flow-model";

/**
 * The flow commands: one checked edit of the stored flow definition each, taken by the draft
 * history through the one apply function. Insert, remove, move and add a branch change the task
 * lists; set a setting changes one property a step's registry declaration types. Every result is
 * checked by `validatedStudioFlowEdit` (limits, source schema, the one flow validator).
 */

export type StudioFlowCalculationOperand =
  | Readonly<{ kind: "literal"; literal:
      | Readonly<{ type: "whole_number"; value: number }>
      | Readonly<{ type: "decimal_number"; value: string }> }>
  | Readonly<{ kind: "input" | "variable"; name: string }>;
export type StudioFlowCalculation = Readonly<{
  operator: "add" | "subtract" | "multiply" | "divide";
  left: StudioFlowCalculationOperand;
  right: StudioFlowCalculationOperand;
  scale: number;
  rounding: FlowRoundingMode;
}>;

/** A setting's new value: a plain value of its declared type, or a two-operand calculation. */
export type StudioFlowSettingValue =
  | Readonly<{ kind: "plain"; value: string | boolean }>
  | Readonly<{ kind: "calculation"; calculation: StudioFlowCalculation }>;

export type StudioFlowCommand =
  | Readonly<{ kind: "insert_task"; taskType: string; listPath: StudioFlowPath; index: number }>
  | Readonly<{ kind: "remove_task"; taskId: string; taskPath: StudioFlowPath }>
  | Readonly<{ kind: "move_task"; taskId: string; taskPath: StudioFlowPath; direction: "up" | "down" }>
  /** Adds the branch a decision is missing (Else, Otherwise) or another parallel branch, starting with one step. */
  | Readonly<{ kind: "add_branch"; taskId: string; taskPath: StudioFlowPath; taskType: string }>
  /** Sets the listed settings of one step together; null removes an optional setting. */
  | Readonly<{ kind: "set_task_settings"; taskId: string; taskPath: StudioFlowPath;
      values: Readonly<Record<string, StudioFlowSettingValue | null>> }>;

type SeededTask = Extract<SourceFlowTask, { properties: unknown }>;
type SettingValue = SeededTask["properties"][string];

const staleEdit = (reason = "The draft or the selected step changed. Select the step again and retry."):
  StudioFlowEditResult => ({ kind: "stale", reason });

// ─── Inserting: registry-seeded steps ────────────────────────────────────────────────────────

/** The minimal valid value for a required property type that has one; other required types cannot be seeded. */
const insertSeeds: Readonly<Partial<Record<FlowTaskPropertyType, SettingValue>>> = {
  message_text: { kind: "literal", literal: { type: "text", value: "Edit this message" } },
  formula: { kind: "formula", formula: { op: "add", args: [
    { op: "literal", type: "whole_number", value: 0 }, { op: "literal", type: "whole_number", value: 0 }],
  scale: 0, rounding: "half_up" } },
};

const seededTask = (definition: FlowTaskTypeDefinition, id: string): SeededTask | undefined => {
  const properties: SeededTask["properties"] = {};
  for (const [key, declaration] of Object.entries(definition.properties)) {
    if (!declaration.required) continue;
    const seed = insertSeeds[declaration.type];
    if (seed === undefined) return undefined;
    properties[key] = structuredClone(seed);
  }
  return { id, type: definition.type, version: definition.version, properties };
};

/** The registry's own placement rule for a flow of this execution kind holding these tasks. */
const placementIssues = (flow: SourceFlow, tasks: readonly SourceFlowTask[]): string[] =>
  validateFlowTaskPlacement({ ...flow, tasks: [...tasks] } as Parameters<typeof validateFlowTaskPlacement>[0])
    .map((issue) => issue.message);

export type StudioFlowStepType = Readonly<{ type: string; title: string; summary: string }>;

/** Registered step types the flow's execution kind accepts and that can start from registry seeds alone. */
const stepTypes = (flow: SourceFlow): readonly StudioFlowStepType[] =>
  Object.values(flowTaskRegistry).flatMap((definition): StudioFlowStepType[] => {
    if (definition.category !== "registered") return [];
    const task = seededTask(definition, "probe");
    if (task === undefined || !sourceFlowTaskSchema.safeParse(task).success ||
      placementIssues({ ...flow, errors: [], finally: [] }, [task]).length > 0) return [];
    return [{ type: definition.type, title: definition.title, summary: definition.summary }];
  });

const uniqueTaskId = (type: string, used: ReadonlySet<string>): string => {
  const base = (type.split(".").pop() ?? type).replace(/[^a-z0-9_]/g, "_");
  let candidate = base;
  for (let n = 2; used.has(candidate); n += 1) candidate = `${base}_${n}`;
  return candidate;
};

const newStep = (flow: SourceFlow, taskType: string, used: ReadonlySet<string>):
  SeededTask | StudioFlowEditResult => {
  const option = stepTypes(flow).find((entry) => entry.type === taskType);
  const definition = option === undefined ? undefined : studioFlowDefinitionOf(option.type);
  const task = definition === undefined ? undefined : seededTask(definition, uniqueTaskId(definition.type, used));
  return task ?? { kind: "unsupported",
    reason: "This flow cannot run that kind of step, or the step needs settings that cannot start from defaults." };
};

// ─── Settings: a form generated from the registry's property declarations ────────────────────

/** How the inspector edits a setting; each maps to one typed value, chosen by the registry's declared type. */
export type StudioFlowSettingControl =
  | "text" | "long_text" | "whole_number" | "decimal_number" | "yes_no" | "date" | "date_time" | "page" | "record_type" | "calculation";

export type StudioFlowSettingField = Readonly<{
  key: string;
  label: string;
  required: boolean;
  /** The control that edits it, or null when the setting can only be read here. */
  control: StudioFlowSettingControl | null;
  /** The current value, or null when it is absent or not editable. */
  value: StudioFlowSettingValue | null;
  display: string;
  /** Why a setting is read-only, in plain language. */
  note?: string;
}>;

export type StudioFlowCalculationReference = Readonly<{ kind: "input" | "variable"; name: string;
  type: "whole_number" | "decimal_number" }>;

export type StudioFlowSettingsProjection =
  | Readonly<{ kind: "available"; fields: readonly StudioFlowSettingField[];
      /** The numbers a calculation may read: the flow's declared numeric inputs and variables. */
      references: readonly StudioFlowCalculationReference[]; note?: string }>
  | Readonly<{ kind: "unavailable"; reason: string; cause?: unknown }>;

type PlainKind = Readonly<{ control: Exclude<StudioFlowSettingControl, "calculation">;
  literal: "text" | "whole_number" | "decimal_number" | "yes_no" | "date" | "date_time" }>;

/** The declared property types a plain value edits. References, maps and structured values are read-only. */
const plainKinds: Readonly<Partial<Record<FlowTaskPropertyType, PlainKind>>> = {
  text: { control: "text", literal: "text" },
  message_text: { control: "long_text", literal: "text" },
  builder_key: { control: "text", literal: "text" },
  namespaced_key: { control: "text", literal: "text" },
  page_id: { control: "page", literal: "text" },
  record_type_id: { control: "record_type", literal: "text" },
  whole_number: { control: "whole_number", literal: "whole_number" },
  decimal_number: { control: "decimal_number", literal: "decimal_number" },
  yes_no: { control: "yes_no", literal: "yes_no" },
  date: { control: "date", literal: "date" },
  date_time: { control: "date_time", literal: "date_time" },
};

const registeredTask = (task: SourceFlowTask): SeededTask | undefined =>
  "properties" in task && "version" in task ? task : undefined;

const plainValue = (kind: PlainKind, value: SettingValue): string | boolean | undefined => {
  if (value.kind !== "literal" || value.literal.type !== kind.literal) return undefined;
  const raw = value.literal.value;
  if (typeof raw === "string" || typeof raw === "boolean") return raw;
  return typeof raw === "number" ? String(raw) : undefined;
};

const onlyKeys = (value: object, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

const calculationReferences = (flow: SourceFlow): StudioFlowCalculationReference[] => {
  const references: StudioFlowCalculationReference[] = [];
  for (const [name, declaration] of Object.entries(flow.inputs ?? {}))
    if (declaration.type === "whole_number" || declaration.type === "decimal_number")
      references.push({ kind: "input", name, type: declaration.type });
  for (const [name, declaration] of Object.entries(flow.variables ?? {}))
    if ((declaration.type === "whole_number" || declaration.type === "decimal_number") && Object.hasOwn(declaration, "default"))
      references.push({ kind: "variable", name, type: declaration.type });
  return references;
};

const operandFormula = (flow: SourceFlow, operand: StudioFlowCalculationOperand): FlowFormula | undefined => {
  if (operand.kind === "literal") {
    if (!onlyKeys(operand, ["kind", "literal"]) || !flowLiteralSchema.safeParse(operand.literal).success) return undefined;
    return { op: "literal", type: operand.literal.type, value: operand.literal.value };
  }
  if (!calculationReferences(flow).some((entry) => entry.kind === operand.kind && entry.name === operand.name)) return undefined;
  return { op: "reference", reference: { source: operand.kind, name: operand.name } };
};

const formulaOperand = (formula: FlowFormula): StudioFlowCalculationOperand | undefined => {
  if (formula.op === "literal") {
    if (formula.type === "whole_number" && typeof formula.value === "number")
      return { kind: "literal", literal: { type: "whole_number", value: formula.value } };
    if (formula.type === "decimal_number" && typeof formula.value === "string")
      return { kind: "literal", literal: { type: "decimal_number", value: formula.value } };
    return undefined;
  }
  if (formula.op === "reference" && (formula.reference.source === "input" || formula.reference.source === "variable") &&
    "name" in formula.reference && typeof formula.reference.name === "string")
    return { kind: formula.reference.source, name: formula.reference.name };
  return undefined;
};

/** A formula the calculation control can show: one operator over two numbers or numeric references. */
const formulaCalculation = (value: SettingValue): StudioFlowCalculation | undefined => {
  if (value.kind !== "formula") return undefined;
  const formula = value.formula;
  if ((formula.op !== "add" && formula.op !== "subtract" && formula.op !== "multiply" && formula.op !== "divide") ||
    !("args" in formula) || formula.args.length !== 2) return undefined;
  const left = formulaOperand(formula.args[0]!);
  const right = formulaOperand(formula.args[1]!);
  return left === undefined || right === undefined ? undefined
    : { operator: formula.op, left, right, scale: formula.scale, rounding: formula.rounding };
};

const readOnlyNote = (type: FlowTaskPropertyType, present: boolean): string =>
  type === "formula" ? "This calculation is more than one operator over two numbers, so it is shown here but not edited."
    : plainKinds[type] === undefined
      ? "This setting points at other parts of the application or holds structured data. It is shown for reference and changed in the source (Releases, Import from source)."
      : present ? "This setting is worked out from other values, not a plain value, so it is shown here but not edited."
        : "This setting cannot be edited here.";

const readableValue = (value: SettingValue): string => {
  if (value.kind === "literal") return typeof value.literal.value === "string" ? value.literal.value : JSON.stringify(value.literal.value);
  if (value.kind === "reference") return `The value of ${studioWords(JSON.stringify(value.reference).replace(/[{}"]/g, " ").trim())}`;
  return "Worked out by the flow";
};

/** The settings form of one selected step, derived only from the registry's declarations for its type. */
export const projectStudioFlowTaskSettings = (
  context: StudioFlowContext,
  selection: StudioFlowSelection,
  taskId: string,
  taskPath: StudioFlowPath,
): StudioFlowSettingsProjection => {
  try {
    const current = studioFlowOutline(context, selection);
    const entry = current.entries.find(({ task, path }) => task.id === taskId && samePath(path, taskPath));
    if (entry === undefined) return { kind: "unavailable", reason: "That step is no longer in the draft." };
    const references = calculationReferences(current.flow);
    const task = registeredTask(entry.task);
    if (task === undefined)
      return { kind: "available", fields: [], references,
        note: "This step shapes the order of the flow. Add steps to its branches on the canvas; its condition is changed in the source." };
    const definition = studioFlowDefinitionOf(task.type, task.version);
    if (definition === undefined)
      return { kind: "unavailable", reason: `The ${studioWords(task.type)} step (version ${task.version}) is not in the step catalogue, so its settings cannot be edited.` };
    const fields = Object.entries(definition.properties).map(([key, declaration]): StudioFlowSettingField => {
      const raw = Object.hasOwn(task.properties, key) ? task.properties[key] : undefined;
      const base = { key, label: studioWords(key), required: declaration.required,
        display: raw === undefined ? "Not set" : readableValue(raw) };
      if (declaration.type === "formula") {
        const calculation = raw === undefined ? undefined : formulaCalculation(raw);
        return calculation === undefined && raw !== undefined
          ? { ...base, control: null, value: null, note: readOnlyNote("formula", true) }
          : { ...base, control: "calculation", value: calculation === undefined ? null : { kind: "calculation", calculation } };
      }
      const kind = plainKinds[declaration.type];
      const value = kind === undefined || raw === undefined ? undefined : plainValue(kind, raw);
      const editable = kind !== undefined && (raw === undefined || value !== undefined);
      return editable
        ? { ...base, control: kind.control, value: value === undefined ? null : { kind: "plain", value } }
        : { ...base, control: null, value: null, note: readOnlyNote(declaration.type, raw !== undefined) };
    });
    for (const [key, raw] of Object.entries(task.properties))
      if (!Object.hasOwn(definition.properties, key))
        fields.push({ key, label: studioWords(key), required: false, control: null, value: null,
          display: readableValue(raw), note: "The step catalogue does not declare this setting, so it cannot be edited here." });
    return { kind: "available", fields, references };
  } catch (cause) {
    return { kind: "unavailable", cause, reason: "The settings of this step could not be read from the draft." };
  }
};

type Literal = Extract<SettingValue, { kind: "literal" }>["literal"];

/** Turns a plain value into the typed literal, or the reason it does not fit the declared type. */
const settingLiteral = (type: FlowTaskPropertyType, kind: PlainKind, value: string | boolean, label: string):
  { ok: true; literal: Literal } | { ok: false; reason: string } => {
  if (kind.control === "yes_no")
    return typeof value === "boolean" ? { ok: true, literal: { type: "yes_no", value } } : { ok: false, reason: `${label}: choose yes or no.` };
  if (typeof value !== "string") return { ok: false, reason: `${label}: enter a value.` };
  const text = kind.control === "text" || kind.control === "long_text" ? value : value.trim();
  if (text.length === 0) return { ok: false, reason: `${label}: enter a value, or remove the setting if it is optional.` };
  if (type === "builder_key" && !builderKeySchema.safeParse(text).success)
    return { ok: false, reason: `${label}: use lowercase words joined by underscores, up to 40 characters, such as follow_up.` };
  if (type === "namespaced_key" && !namespacedKeySchema.safeParse(text).success)
    return { ok: false, reason: `${label}: use lowercase names joined by dots, such as record.saved.` };
  if (type === "message_text" && text.length > 2_000) return { ok: false, reason: `${label}: use at most 2000 characters.` };
  if (kind.control === "whole_number") {
    if (!/^-?(?:0|[1-9]\d*)$/.test(text) || !Number.isSafeInteger(Number(text)))
      return { ok: false, reason: `${label}: enter a whole number without decimals or spaces.` };
    return { ok: true, literal: { type: "whole_number", value: Number(text) } };
  }
  const literal = { type: kind.literal, value: text };
  const checked = flowLiteralSchema.safeParse(literal);
  if (!checked.success) return { ok: false, reason: `${label}: ${checked.error.issues[0]?.message ?? "this value does not fit the setting"}.` };
  return { ok: true, literal: literal as Literal };
};

const calculationValue = (flow: SourceFlow, calculation: StudioFlowCalculation, label: string):
  { ok: true; value: SettingValue } | { ok: false; reason: string } => {
  if (!["add", "subtract", "multiply", "divide"].includes(calculation.operator))
    return { ok: false, reason: `${label}: choose add, subtract, multiply or divide.` };
  if (!Number.isInteger(calculation.scale) || calculation.scale < 0 || calculation.scale > 18)
    return { ok: false, reason: `${label}: keep between 0 and 18 decimal places.` };
  if (!flowRoundingModeSchema.safeParse(calculation.rounding).success) return { ok: false, reason: `${label}: choose how to round.` };
  const left = operandFormula(flow, calculation.left);
  const right = operandFormula(flow, calculation.right);
  if (left === undefined || right === undefined)
    return { ok: false, reason: `${label}: each side must be a number or one of the flow's numeric inputs or variables.` };
  const formula: FlowFormula = { op: calculation.operator, args: [left, right], scale: calculation.scale, rounding: calculation.rounding };
  if (!flowFormulaSchema.safeParse(formula).success) return { ok: false, reason: `${label}: this calculation is not valid.` };
  return { ok: true, value: { kind: "formula", formula } };
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
    const types = current.entries.length < flowMaximumTaskCount ? stepTypes(current.flow) : [];
    if (taskPath === null) return { stepTypes: types, canMoveUp: false, canMoveDown: false, branch: null };
    const index = taskPath[taskPath.length - 1];
    const list = studioFlowListAt(current.flow, taskPath.slice(0, -1));
    const task = typeof index === "number" ? list?.[index] : undefined;
    const branch = task === undefined ? null
      : task.type === "if" && "then" in task && task.else === undefined ? "Else"
        : task.type === "switch" && "cases" in task && task.default === undefined ? "Otherwise"
          : task.type === "parallel" && "branches" in task ? `Branch ${task.branches.length + 1}` : null;
    return { stepTypes: types, canMoveUp: typeof index === "number" && index > 0,
      canMoveDown: typeof index === "number" && list !== undefined && index < list.length - 1, branch };
  } catch {
    return { stepTypes: [], canMoveUp: false, canMoveDown: false, branch: null };
  }
};

/** The step types for a flow, or why none could be worked out. */
export const projectStudioFlowStepTypes = (context: StudioFlowContext, selection: StudioFlowSelection):
  readonly StudioFlowStepType[] => projectStudioFlowStepActions(context, selection, null).stepTypes;

// ─── Removing ────────────────────────────────────────────────────────────────────────────────

/** Refuse retained references; never turn deletion into an implicit reference repair. */
const hasRetainedTaskReference = (source: Readonly<ApplicationSourceDocument>, taskId: string): boolean => {
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
      if (("source" in value && value.source === "task_output" && "task" in value && value.task === taskId) ||
        ("kind" in value && value.kind === "flow_node" && "key" in value && value.key === taskId)) return true;
      pending.push(...Object.values(value));
    }
  }
  return false;
};

// ─── The one apply function ──────────────────────────────────────────────────────────────────

const commandTask = (lists: readonly StudioFlowTaskListOutline[], id: string, path: StudioFlowPath): string | undefined => {
  for (const list of lists) for (const task of list.tasks) {
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
    const done = (taskId: string) => validatedStudioFlowEdit(candidate, current.source, expectedSelection, taskId, current);
    const full = original.entries.length >= flowMaximumTaskCount
      ? { kind: "invalid" as const, reason: `A flow can hold at most ${flowMaximumTaskCount} steps, nested steps included.` } : undefined;

    if (command.kind === "insert_task") {
      const target = studioFlowListAt(detached, command.listPath);
      if (target === undefined || !Number.isInteger(command.index) || command.index < 0 || command.index > target.length)
        return staleEdit("That place in the flow changed. Select a step again and retry.");
      if (full !== undefined) return full;
      const task = newStep(original.flow, command.taskType, used);
      if ("kind" in task && !("id" in task)) return task;
      target.splice(command.index, 0, task as SeededTask);
      return done((task as SeededTask).id);
    }

    if (!builderKeySchema.safeParse(command.taskId).success || commandTask(original.lists, command.taskId, command.taskPath) === undefined)
      return staleEdit("That step is no longer in the draft. Select it again.");
    const index = command.taskPath[command.taskPath.length - 1];
    const parentPath = command.taskPath.slice(0, -1);
    const list = studioFlowListAt(detached, parentPath);
    if (typeof index !== "number" || list?.[index]?.id !== command.taskId) return staleEdit();

    switch (command.kind) {
      case "remove_task": {
        if (list.length === 1 && parentPath[0] !== "errors" && parentPath[0] !== "finally")
          return { kind: "unsupported", reason: parentPath.length === 1
            ? "A flow keeps at least one step. Add another step first, then remove this one."
            : "A branch keeps at least one step. Remove the step that owns the branch instead." };
        const removed = original.entries
          .filter(({ path }) => path.length >= command.taskPath.length && samePath(path.slice(0, command.taskPath.length), command.taskPath))
          .map(({ task }) => task.id);
        list.splice(index, 1);
        const referenced = removed.find((id) => hasRetainedTaskReference(candidate, id));
        if (referenced !== undefined)
          return { kind: "unsupported", reason: "Another step or part of the application still reads the result of this step. Change that first." };
        return done(command.taskId);
      }
      case "move_task": {
        const to = index + (command.direction === "up" ? -1 : 1);
        if (to < 0 || to >= list.length)
          return { kind: "invalid", reason: command.direction === "up" ? "This step is already first in its list." : "This step is already last in its list." };
        const [moved] = list.splice(index, 1);
        list.splice(to, 0, moved!);
        return done(command.taskId);
      }
      case "add_branch": {
        if (full !== undefined) return full;
        const task = newStep(original.flow, command.taskType, used);
        if ("kind" in task && !("id" in task)) return task;
        const owner = list[index]!;
        if (owner.type === "if" && "then" in owner && owner.else === undefined) owner.else = [task as SeededTask];
        else if (owner.type === "switch" && "cases" in owner && owner.default === undefined) owner.default = [task as SeededTask];
        else if (owner.type === "parallel" && "branches" in owner) owner.branches.push([task as SeededTask]);
        else return { kind: "unsupported", reason: "This step has no branch to add. Only a decision without Else or Otherwise, or a parallel step, can get one." };
        return done((task as SeededTask).id);
      }
      case "set_task_settings": {
        const task = registeredTask(list[index]!);
        const definition = task === undefined ? undefined : studioFlowDefinitionOf(task.type, task.version);
        if (task === undefined || definition === undefined)
          return { kind: "unsupported", reason: "This step has no settings the step catalogue declares, so none can be edited." };
        const where = describeStudioFlowLocation(original.flow, command.taskPath);
        let changed = 0;
        for (const [property, value] of Object.entries(command.values)) {
          const declaration = Object.hasOwn(definition.properties, property) ? definition.properties[property] : undefined;
          const label = `${where}, ${studioWords(property)}`;
          if (declaration === undefined)
            return { kind: "unsupported", reason: `${label}: the step catalogue does not declare this setting, so it cannot be edited.` };
          const existing = Object.hasOwn(task.properties, property) ? task.properties[property] : undefined;
          let replacement: SettingValue | undefined;
          if (value === null) {
            if (declaration.required) return { kind: "invalid", reason: `${label} is required, so it cannot be removed.` };
          } else if (value.kind === "calculation") {
            if (declaration.type !== "formula") return { kind: "unsupported", reason: `${label} is not a calculation.` };
            if (existing !== undefined && formulaCalculation(existing) === undefined)
              return { kind: "unsupported", reason: `${label} is more than one operator over two numbers, so it is changed in the source.` };
            const result = calculationValue(original.flow, value.calculation, label);
            if (!result.ok) return { kind: "invalid", reason: result.reason };
            replacement = result.value;
          } else {
            const kind = plainKinds[declaration.type];
            if (kind === undefined)
              return { kind: "unsupported", reason: `${label} points at other parts of the application or holds structured data, so it is changed in the source.` };
            if (existing !== undefined && plainValue(kind, existing) === undefined)
              return { kind: "unsupported", reason: `${label} is worked out from other values, so it is not edited as a plain value.` };
            const literal = settingLiteral(declaration.type, kind, value.value, label);
            if (!literal.ok) return { kind: "invalid", reason: literal.reason };
            replacement = { kind: "literal", literal: literal.literal };
          }
          if (JSON.stringify(existing) === JSON.stringify(replacement)) continue;
          changed += 1;
          if (replacement === undefined) delete task.properties[property];
          else task.properties[property] = replacement;
        }
        if (changed === 0) return { kind: "invalid", reason: "These settings already have these values. Nothing was changed." };
        return done(command.taskId);
      }
    }
  } catch (cause) {
    return { kind: "invalid", cause, reason: "The draft could not be read to make this change." };
  }
};
