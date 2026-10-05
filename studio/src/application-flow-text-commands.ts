import {
  applicationRootIdSchema,
  applicationSourceDocumentV2Schema,
  builderKeySchema,
  flowLiteralSchema,
  flowFormulaSchema,
  flowRoundingModeSchema,
  flowMaximumTaskCount,
  flowMaximumTaskNestingDepth,
  flowTaskRegistry,
  organizationIdSchema,
  parseFlowReference,
  sourceFlowTaskSchema,
  type ApplicationRootId,
  type ApplicationSourceDocumentV2,
  type FlowFormula,
  type FlowRoundingMode,
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

export type StudioFlowPresentationMoveOption = Readonly<{
  direction: "up" | "down";
  taskId: string;
  taskPath: readonly (string | number)[];
  neighborId: string;
  neighborPath: readonly (string | number)[];
}>;
export type StudioFlowPresentationMoveCommand = StudioFlowPresentationMoveOption &
  Readonly<{ kind: "move_presentation" }>;

export type StudioFlowPresentationRemovalCommand = Readonly<{
  kind: "remove_presentation";
  taskId: string;
  taskPath: readonly (string | number)[];
}>;

export type StudioFlowCalculateOperand =
  | Readonly<{ kind: "literal"; literal:
      | Readonly<{ type: "whole_number"; value: number }>
      | Readonly<{ type: "decimal_number"; value: string }> }>
  | Readonly<{ kind: "input" | "variable"; name: string }>;
export type StudioFlowCalculateSettings = Readonly<{
  operator: "add" | "subtract" | "multiply" | "divide";
  left: StudioFlowCalculateOperand;
  right: StudioFlowCalculateOperand;
  scale: number;
  rounding: FlowRoundingMode;
}>;
export type StudioFlowCalculateCommand = StudioFlowCalculateSettings & (
  | Readonly<{ kind: "append_calculate"; taskId: string }>
  | Readonly<{ kind: "edit_calculate"; taskId: string; taskPath: readonly (string | number)[] }>
);
export type StudioFlowCalculateProjection =
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{
      kind: "available";
      canAppend: boolean;
      references: readonly Readonly<{ kind: "input" | "variable"; name: string;
        type: "whole_number" | "decimal_number" }>[];
      selected: (StudioFlowCalculateSettings & Readonly<{ taskId: string;
        taskPath: readonly (string | number)[] }>) | null;
    }>;

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

const movablePresentationTask = (task: SourceFlowTask): boolean => {
  if (!("version" in task) || !("properties" in task) ||
    Object.keys(task).some((key) => !["id", "type", "version", "properties", "description"].includes(key)))
    return false;
  const definition = presentationPalette().find((entry) => entry.type === task.type && entry.version === task.version);
  if (definition === undefined) return false;
  const allowed = task.type === "interface.confirm" ? ["message", "title"] : ["message"];
  if (!Object.hasOwn(task.properties, "message") ||
    Object.keys(task.properties).some((key) => !allowed.includes(key))) return false;
  return Object.values(task.properties).every((value) => value.kind === "literal" &&
    value.literal.type === "text" && validPresentationText(value.literal.value));
};

const directTaskIndex = (path: readonly (string | number)[]): number | undefined =>
  path.length === 2 && path[0] === "tasks" && typeof path[1] === "number" &&
    Number.isSafeInteger(path[1]) && path[1] >= 0 ? path[1] : undefined;

const onlyKeys = (value: object, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

const calculateRegistryAvailable = (flow: SourceFlow): boolean => {
  const definition = flowTaskRegistry["data.calculate"];
  const location = flow.execution === "interactive" ? "browser" : "transaction";
  return (flow.execution === "interactive" || flow.execution === "transaction") &&
    flow.runAs.kind === "initiator" && definition.type === "data.calculate" &&
    definition.version === "1.0.0" && definition.effect === "pure" &&
    definition.runLocations.includes(location) &&
    Object.keys(definition.properties).length === 1 &&
    definition.properties.formula?.type === "formula" && definition.properties.formula.required &&
    definition.outputs.length === 1 && definition.outputs[0]?.key === "value" &&
    definition.outputs[0].type === "json";
};

const calculateReferences = (flow: SourceFlow):
  Extract<StudioFlowCalculateProjection, { kind: "available" }>["references"] => {
  const references: { kind: "input" | "variable"; name: string;
    type: "whole_number" | "decimal_number" }[] = [];
  for (const [name, declaration] of Object.entries(flow.inputs)) {
    if ((declaration.type === "whole_number" || declaration.type === "decimal_number") &&
      (declaration.required || (Object.hasOwn(declaration, "default") &&
        flowLiteralSchema.safeParse({ type: declaration.type, value: declaration.default }).success)))
      references.push({ kind: "input", name, type: declaration.type });
  }
  for (const [name, declaration] of Object.entries(flow.variables)) {
    if ((declaration.type === "whole_number" || declaration.type === "decimal_number") &&
      Object.hasOwn(declaration, "default") &&
      flowLiteralSchema.safeParse({ type: declaration.type, value: declaration.default }).success)
      references.push({ kind: "variable", name, type: declaration.type });
  }
  return references;
};

const calculateOperandFormula = (flow: SourceFlow, operand: StudioFlowCalculateOperand):
  FlowFormula | undefined => {
  if (operand.kind === "literal") {
    if (!onlyKeys(operand, ["kind", "literal"]) ||
      !onlyKeys(operand.literal, ["type", "value"]) ||
      (operand.literal.type === "whole_number" ? typeof operand.literal.value !== "number"
        : operand.literal.type !== "decimal_number" || typeof operand.literal.value !== "string") ||
      !flowLiteralSchema.safeParse(operand.literal).success) return undefined;
    return { op: "literal", type: operand.literal.type, value: operand.literal.value };
  }
  if ((operand.kind !== "input" && operand.kind !== "variable") ||
    !onlyKeys(operand, ["kind", "name"]) ||
    !calculateReferences(flow).some((entry) => entry.kind === operand.kind && entry.name === operand.name))
    return undefined;
  return { op: "reference", reference: { source: operand.kind, name: operand.name } };
};

const calculateFormulaOperand = (flow: SourceFlow, formula: FlowFormula):
  StudioFlowCalculateOperand | undefined => {
  if (formula.op === "literal" && onlyKeys(formula, ["op", "type", "value"])) {
    const operand: StudioFlowCalculateOperand | undefined =
      formula.type === "whole_number" && typeof formula.value === "number"
        ? { kind: "literal", literal: { type: "whole_number", value: formula.value } }
        : formula.type === "decimal_number" && typeof formula.value === "string"
          ? { kind: "literal", literal: { type: "decimal_number", value: formula.value } }
          : undefined;
    return operand !== undefined && calculateOperandFormula(flow, operand) !== undefined ? operand : undefined;
  }
  if (formula.op === "reference" && onlyKeys(formula, ["op", "reference"]) &&
    typeof formula.reference === "object" && formula.reference !== null &&
    (formula.reference.source === "input" || formula.reference.source === "variable") &&
    onlyKeys(formula.reference, ["source", "name"])) {
    const operand: StudioFlowCalculateOperand = { kind: formula.reference.source, name: formula.reference.name };
    return calculateOperandFormula(flow, operand) === undefined ? undefined : operand;
  }
  return undefined;
};

const calculateSettings = (flow: SourceFlow, task: SourceFlowTask): StudioFlowCalculateSettings | undefined => {
  if (task.type !== "data.calculate" || !("version" in task) || task.version !== "1.0.0" ||
    !("properties" in task) || !onlyKeys(task, ["id", "type", "version", "properties", "description"]) ||
    Object.keys(task.properties).length !== 1) return undefined;
  const value = task.properties.formula;
  if (value?.kind !== "formula" || !onlyKeys(value, ["kind", "formula"]) ||
    !flowFormulaSchema.safeParse(value.formula).success) return undefined;
  const formula = value.formula;
  if ((formula.op !== "add" && formula.op !== "subtract" && formula.op !== "multiply" && formula.op !== "divide") ||
    !onlyKeys(formula, ["op", "args", "scale", "rounding"]) || formula.args.length !== 2)
    return undefined;
  const left = calculateFormulaOperand(flow, formula.args[0]!);
  const right = calculateFormulaOperand(flow, formula.args[1]!);
  return left === undefined || right === undefined ? undefined
    : { operator: formula.op, left, right, scale: formula.scale, rounding: formula.rounding };
};

/** Projects only real declared numeric operands and the closed, registered arithmetic participant. */
export const projectStudioFlowCalculateEditor = (
  context: StudioFlowTextContext,
  selection: FlowSelection,
  taskId?: string,
  taskPath?: readonly (string | number)[],
): StudioFlowCalculateProjection => {
  try {
    const current = outline(context, selection);
    if (!calculateRegistryAvailable(current.flow)) return { kind: "unavailable" };
    const index = taskPath === undefined ? undefined : directTaskIndex(taskPath);
    const task = index === undefined ? undefined : current.flow.tasks[index];
    const settings = task !== undefined && task.id === taskId ? calculateSettings(current.flow, task) : undefined;
    return { kind: "available", canAppend: current.entries.length < flowMaximumTaskCount,
      references: calculateReferences(current.flow), selected: settings === undefined || task === undefined || taskPath === undefined
        ? null : { ...settings, taskId: task.id, taskPath: [...taskPath] } };
  } catch { return { kind: "unavailable" }; }
};

/** Adds or edits one Calculate formula on detached authored source; it grants no execution authority. */
export const applyStudioFlowCalculateCommand = (
  current: StudioFlowTextContext,
  expected: StudioFlowTextContext,
  selection: StudioSemanticSelection | null,
  expectedSelection: FlowSelection,
  command: StudioFlowCalculateCommand,
): StudioFlowTextResult => {
  if (current.organizationId !== expected.organizationId || current.rootId !== expected.rootId ||
    current.key !== expected.key || current.draftRevision !== expected.draftRevision ||
    current.localLifetime !== expected.localLifetime || current.source !== expected.source ||
    selection?.kind !== "flow" || selection.flowAlias !== expectedSelection.flowAlias)
    return { kind: "stale" };
  try {
    const original = outline(current, expectedSelection);
    if (!calculateRegistryAvailable(original.flow)) return { kind: "unsupported" };
    if ((command.kind !== "append_calculate" && command.kind !== "edit_calculate") ||
      !onlyKeys(command, ["kind", "taskId", "operator", "left", "right", "scale", "rounding",
        ...(command.kind === "edit_calculate" ? ["taskPath"] : [])]) ||
      !builderKeySchema.safeParse(command.taskId).success ||
      (command.operator !== "add" && command.operator !== "subtract" && command.operator !== "multiply" && command.operator !== "divide") ||
      !Number.isInteger(command.scale) || command.scale < 0 || command.scale > 18 ||
      !flowRoundingModeSchema.safeParse(command.rounding).success) return { kind: "invalid" };
    const left = calculateOperandFormula(original.flow, command.left);
    const right = calculateOperandFormula(original.flow, command.right);
    if (left === undefined || right === undefined) return { kind: "invalid" };
    const formula: FlowFormula = {
      op: command.operator, args: [left, right], scale: command.scale, rounding: command.rounding,
    };
    if (!flowFormulaSchema.safeParse(formula).success) return { kind: "invalid" };
    const index = command.kind === "edit_calculate" ? directTaskIndex(command.taskPath) : undefined;
    if (command.kind === "edit_calculate") {
      const task = index === undefined ? undefined : original.flow.tasks[index];
      if (task === undefined || task.id !== command.taskId) return { kind: "stale" };
      const settings = calculateSettings(original.flow, task);
      if (settings === undefined) return { kind: "unsupported" };
      const normalized = { operator: command.operator,
        left: calculateFormulaOperand(original.flow, left), right: calculateFormulaOperand(original.flow, right),
        scale: command.scale, rounding: command.rounding };
      if (JSON.stringify(settings) === JSON.stringify(normalized)) return { kind: "no_change" };
    } else if (original.entries.length >= flowMaximumTaskCount ||
      original.entries.some(({ task }) => task.id === command.taskId)) return { kind: "invalid" };
    const candidate: ApplicationSourceDocumentV2 = structuredClone(current.source);
    const detached = outline({ ...current, source: candidate }, expectedSelection);
    if (command.kind === "append_calculate") {
      const task: Extract<SourceFlowTask, { properties: unknown }> = {
        id: command.taskId, type: "data.calculate", version: "1.0.0",
        properties: { formula: { kind: "formula", formula } },
      };
      if (!sourceFlowTaskSchema.safeParse(task).success) return { kind: "invalid" };
      detached.flow.tasks.push(task);
    } else {
      const task = index === undefined ? undefined : detached.flow.tasks[index];
      if (task === undefined || task.id !== command.taskId || !("properties" in task)) return { kind: "stale" };
      task.properties.formula = { kind: "formula", formula };
    }
    outline({ ...current, source: candidate }, expectedSelection);
    if (!applicationSourceDocumentV2Schema.safeParse(candidate).success) return { kind: "invalid" };
    return { kind: "applied", source: candidate };
  } catch { return { kind: "invalid" }; }
};

const presentationMoves = (flow: SourceFlow, taskId: string,
  taskPath: readonly (string | number)[]): readonly StudioFlowPresentationMoveOption[] => {
  const index = directTaskIndex(taskPath);
  if (flow.execution !== "interactive" || flow.runAs.kind !== "initiator" || index === undefined) return [];
  const task = flow.tasks[index];
  if (task === undefined || task.id !== taskId || !movablePresentationTask(task)) return [];
  const directions: readonly ("up" | "down")[] = ["up", "down"];
  return directions.flatMap((direction): StudioFlowPresentationMoveOption[] => {
    const neighborIndex = index + (direction === "up" ? -1 : 1);
    const neighbor = flow.tasks[neighborIndex];
    return neighbor === undefined || !movablePresentationTask(neighbor) ? [] : [{
      direction, taskId, taskPath: ["tasks", index], neighborId: neighbor.id,
      neighborPath: ["tasks", neighborIndex],
    }];
  });
};

/** Adjacent literal-only participants cannot read each other's outputs or cross another task. */
export const projectStudioFlowPresentationMoves = (
  context: StudioFlowTextContext,
  selection: FlowSelection,
  taskId: string,
  taskPath: readonly (string | number)[],
): readonly StudioFlowPresentationMoveOption[] => {
  try { return presentationMoves(outline(context, selection).flow, taskId, taskPath); }
  catch { return []; }
};

/** Exchanges two complete existing tasks, preserving every named identity and source omission. */
export const applyStudioFlowPresentationMoveCommand = (
  current: StudioFlowTextContext,
  expected: StudioFlowTextContext,
  selection: StudioSemanticSelection | null,
  expectedSelection: FlowSelection,
  command: StudioFlowPresentationMoveCommand,
): StudioFlowTextResult => {
  if (current.organizationId !== expected.organizationId || current.rootId !== expected.rootId ||
    current.key !== expected.key || current.draftRevision !== expected.draftRevision ||
    current.localLifetime !== expected.localLifetime || current.source !== expected.source ||
    selection?.kind !== "flow" || selection.flowAlias !== expectedSelection.flowAlias)
    return { kind: "stale" };
  try {
    if (command.kind !== "move_presentation" || (command.direction !== "up" && command.direction !== "down") ||
      Object.keys(command).some((key) => !["kind", "direction", "taskId", "taskPath", "neighborId", "neighborPath"].includes(key)))
      return { kind: "invalid" };
    const original = outline(current, expectedSelection);
    const index = directTaskIndex(command.taskPath);
    if (index === undefined || original.flow.execution !== "interactive" || original.flow.runAs.kind !== "initiator")
      return { kind: "unsupported" };
    const target = original.flow.tasks[index];
    if (target === undefined || target.id !== command.taskId) return { kind: "stale" };
    if (!movablePresentationTask(target)) return { kind: "unsupported" };
    const neighborIndex = index + (command.direction === "up" ? -1 : 1);
    if (neighborIndex < 0 || neighborIndex >= original.flow.tasks.length) return { kind: "no_change" };
    const option = presentationMoves(original.flow, command.taskId, command.taskPath)
      .find((entry) => entry.direction === command.direction);
    if (option === undefined) return { kind: "unsupported" };
    if (option.neighborId !== command.neighborId || !samePath(option.neighborPath, command.neighborPath))
      return { kind: "stale" };
    const candidate: ApplicationSourceDocumentV2 = structuredClone(current.source);
    const detached = outline({ ...current, source: candidate }, expectedSelection);
    const moved = detached.flow.tasks[index];
    const neighbor = detached.flow.tasks[neighborIndex];
    if (moved === undefined || neighbor === undefined || moved.id !== command.taskId || neighbor.id !== command.neighborId)
      return { kind: "stale" };
    detached.flow.tasks[index] = neighbor;
    detached.flow.tasks[neighborIndex] = moved;
    outline({ ...current, source: candidate }, expectedSelection);
    if (!applicationSourceDocumentV2Schema.safeParse(candidate).success) return { kind: "invalid" };
    return { kind: "applied", source: candidate };
  } catch { return { kind: "invalid" }; }
};

const removableMessageTask = (task: SourceFlowTask): boolean => {
  if (task.type !== "interface.show_message" || !("version" in task) ||
    !("properties" in task) || task.version !== "1.0.0" ||
    Object.keys(task).some((key) => !["id", "type", "version", "properties", "description"].includes(key)))
    return false;
  const definition = Object.values(flowTaskRegistry).find((entry) => entry.type === task.type);
  if (definition === undefined || definition.version !== task.version ||
    definition.effect !== "interface" || !definition.runLocations.includes("browser") ||
    definition.outputs.length !== 0 || definition.properties.message?.type !== "message_text" ||
    !definition.properties.message.required || Object.keys(task.properties).length !== 1 ||
    !Object.hasOwn(task.properties, "message")) return false;
  const message = task.properties.message;
  return message?.kind === "literal" && message.literal.type === "text" &&
    validPresentationText(message.literal.value);
};

/** Refuse retained references; never turn deletion into an implicit reference repair. */
const hasRetainedTaskReference = (source: Readonly<ApplicationSourceDocumentV2>, taskId: string): boolean => {
  // The whole source has already passed its shared node, depth and cycle bounds in outline.
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
      // Includes formulas, maps, arrays, output values and every nested/control/error/finally list.
      // A same-key reference in another Flow is conservatively refused rather than guessed at.
      pending.push(...Object.values(value));
    }
  }
  return false;
};

const presentationRemoval = (context: StudioFlowTextContext, selection: FlowSelection,
  taskId: string, taskPath: readonly (string | number)[]): boolean => {
  const { flow } = outline(context, selection);
  const index = directTaskIndex(taskPath);
  if (flow.execution !== "interactive" || flow.runAs.kind !== "initiator" ||
    flow.tasks.length <= 1 || index === undefined) return false;
  const task = flow.tasks[index];
  return task !== undefined && task.id === taskId && removableMessageTask(task) &&
    !hasRetainedTaskReference(context.source, taskId);
};

/** Only one direct, unreferenced literal Show message can be removed through this inspector. */
export const projectStudioFlowPresentationRemoval = (
  context: StudioFlowTextContext,
  selection: FlowSelection,
  taskId: string,
  taskPath: readonly (string | number)[],
): boolean => {
  try { return presentationRemoval(context, selection, taskId, taskPath); }
  catch { return false; }
};

export const applyStudioFlowPresentationRemovalCommand = (
  current: StudioFlowTextContext,
  expected: StudioFlowTextContext,
  selection: StudioSemanticSelection | null,
  expectedSelection: FlowSelection,
  command: StudioFlowPresentationRemovalCommand,
): StudioFlowTextResult => {
  if (current.organizationId !== expected.organizationId || current.rootId !== expected.rootId ||
    current.key !== expected.key || current.draftRevision !== expected.draftRevision ||
    current.localLifetime !== expected.localLifetime || current.source !== expected.source ||
    selection?.kind !== "flow" || selection.flowAlias !== expectedSelection.flowAlias)
    return { kind: "stale" };
  try {
    if (command.kind !== "remove_presentation" ||
      Object.keys(command).some((key) => !["kind", "taskId", "taskPath"].includes(key)) ||
      !builderKeySchema.safeParse(command.taskId).success) return { kind: "invalid" };
    const original = outline(current, expectedSelection);
    const index = directTaskIndex(command.taskPath);
    if (index === undefined) return { kind: "unsupported" };
    const task = original.flow.tasks[index];
    if (task === undefined || task.id !== command.taskId) return { kind: "stale" };
    if (!presentationRemoval(current, expectedSelection, command.taskId, command.taskPath))
      return { kind: "unsupported" };
    const candidate: ApplicationSourceDocumentV2 = structuredClone(current.source);
    const detached = outline({ ...current, source: candidate }, expectedSelection);
    if (detached.flow.tasks[index]?.id !== command.taskId) return { kind: "stale" };
    detached.flow.tasks.splice(index, 1);
    outline({ ...current, source: candidate }, expectedSelection);
    if (!applicationSourceDocumentV2Schema.safeParse(candidate).success) return { kind: "invalid" };
    return { kind: "applied", source: candidate };
  } catch { return { kind: "invalid" }; }
};
