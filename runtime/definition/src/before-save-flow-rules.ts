import {
  sourceRuleGraphSchema,
  type DefinitionRuleFailureFamily,
  type FlowFormula,
  type FlowValue,
  type SourceFlow,
  type SourceFlowTask,
  type SourceRuleGraph,
  type SourceRuleGraphCondition,
  type SourceRuleGraphNode,
  type SourceRuleGraphOperand,
  type SourceRuleGraphEdge,
} from "@vortex/contracts";
import type { DefinitionCompilerRefusalCode } from "./compilation-error";

/**
 * The executable form of a `BeforeSave` flow.
 *
 * A save rule is authored as a flow (architecture decision 3): a `BeforeSave` trigger, `transaction`
 * execution, and a nested task list of If, Require field, Warn, Refuse save and Stop tasks. The
 * database read that hands a save its rules and the before-save evaluator still read a rule graph,
 * so until the flow interpreter replaces them (#1007) every `BeforeSave` flow is lowered here to
 * the one rule graph that runs the same checks in the same order with the same outcome. The
 * lowering is pure and total over what it understands; everything else is refused with the task
 * that cannot be lowered, so a rule is never compiled into something that quietly does less than
 * its flow says.
 *
 * Node aliases are derived from the flow's own task ids, so the identities the graph needs can be
 * listed from the source alone (`source-identities.ts`).
 */

type Path = (string | number)[];

export type BeforeSaveLoweringRefusal = Readonly<{
  ruleCode: DefinitionCompilerRefusalCode;
  family: DefinitionRuleFailureFamily;
  /** Path inside the flow of the first thing that cannot be lowered. */
  path: Path;
  /** The innermost task that cannot be lowered, when the refusal is inside one. */
  taskId?: string;
}>;

export type BeforeSaveLowering =
  | Readonly<{ ok: true; graph: SourceRuleGraph }>
  | Readonly<{ ok: false; refusal: BeforeSaveLoweringRefusal }>;

class Refused extends Error {
  constructor(readonly refusal: BeforeSaveLoweringRefusal) {
    super(refusal.ruleCode);
  }
}

const unsupported = (path: Path): never => {
  throw new Refused({
    ruleCode: "vortex.definition.unsupported_workflow_node",
    family: "unsupported_choice",
    path,
  });
};

const invalidValue = (path: Path): never => {
  throw new Refused({
    ruleCode: "vortex.definition.workflow_node_values",
    family: "invalid_value",
    path,
  });
};

/** Whether the flow is a save rule: it has a `BeforeSave` trigger. */
export const isBeforeSaveFlow = (flow: SourceFlow): boolean =>
  flow.triggers.some((trigger) => trigger.type === "BeforeSave");

export const startNodeAlias = "start";
export const finishNodeAlias = "finish";
export const taskNodeAlias = (taskId: string): string => `task_${taskId}`;

// ─── Conditions ────────────────────────────────────────────────────────────────────────────────

const comparisonOperators = {
  eq: "equals",
  neq: "not_equals",
  lt: "less_than",
  lte: "less_than_or_equal",
  gt: "greater_than",
  gte: "greater_than_or_equal",
  contains: "contains",
} as const;

/** The flow literal types a rule graph can hold, with the rule graph's own name for each. */
const literalTypes: Readonly<Record<string, string>> = {
  text: "text",
  whole_number: "whole_number",
  decimal_number: "decimal_number",
  yes_no: "yes_no",
  date: "date",
  date_time: "date_time",
  choice: "choice",
  several_choices: "several_choices",
};

const operand = (formula: FlowFormula, path: Path): SourceRuleGraphOperand => {
  if (formula.op === "literal") {
    const type = literalTypes[formula.type];
    if (type === undefined) return invalidValue(path);
    // A decimal is exact text in a rule graph; a flow may write it as a number or as text.
    const value = type === "decimal_number" ? String(formula.value) : formula.value;
    return { source: "literal", value: { type, value } } as SourceRuleGraphOperand;
  }
  if (formula.op === "reference") {
    const reference = formula.reference;
    if (reference.source === "trigger_record")
      return { source: "current_field", field: reference.field };
    if (reference.source === "trigger_previous")
      return { source: "previous_field", field: reference.field };
  }
  return unsupported(path);
};

const condition = (formula: FlowFormula, path: Path): SourceRuleGraphCondition => {
  switch (formula.op) {
    case "and":
      return {
        kind: "all",
        conditions: formula.args.map((arg, index) => condition(arg, [...path, "args", index])),
      };
    case "or":
      return {
        kind: "any",
        conditions: formula.args.map((arg, index) => condition(arg, [...path, "args", index])),
      };
    case "not":
      return { kind: "not", condition: condition(formula.arg, [...path, "arg"]) };
    case "eq":
    case "neq":
    case "lt":
    case "lte":
    case "gt":
    case "gte":
    case "contains":
      return {
        kind: "comparison",
        operator: comparisonOperators[formula.op],
        left: operand(formula.left, [...path, "left"]),
        right: operand(formula.right, [...path, "right"]),
      };
    case "is_empty":
    case "is_not_empty":
      return {
        kind: "comparison",
        operator: formula.op,
        left: operand(formula.arg, [...path, "arg"]),
      };
    case "in": {
      const value = operand(formula.value, [...path, "value"]);
      const options = formula.options.map(
        (option, index): SourceRuleGraphCondition => ({
          kind: "comparison",
          operator: "equals",
          left: value,
          right: operand(option, [...path, "options", index]),
        }),
      );
      return options.length === 1 ? options[0]! : { kind: "any", conditions: options };
    }
    default:
      return unsupported(path);
  }
};

// ─── Text properties ─────────────────────────────────────────────────────────────────────────

const textOf = (value: FlowValue | undefined, path: Path): string | undefined => {
  if (value === undefined) return undefined;
  if (
    value.kind === "literal" &&
    value.literal.type === "text" &&
    typeof value.literal.value === "string"
  )
    return value.literal.value;
  return invalidValue(path);
};

const required = <T>(value: T | undefined, path: Path): T =>
  value === undefined ? invalidValue(path) : value;

// ─── Tasks ─────────────────────────────────────────────────────────────────────────────────────

type Builder = {
  readonly nodes: SourceRuleGraphNode[];
  readonly edges: SourceRuleGraphEdge[];
  /** The one record type every field of this rule is read from, as its trigger names it. */
  readonly recordType: string;
  finishUsed: boolean;
};

const nodeBase = { node_version: "1.0.0" } as const;

/** `record.field` for the rule's own record type; a field of any other record is not lowerable. */
const fieldAlias = (builder: Builder, value: FlowValue | undefined, path: Path): string => {
  const reference = required(textOf(value, path), path);
  const dot = reference.indexOf(".");
  if (dot < 1 || reference.slice(0, dot) !== builder.recordType) return invalidValue(path);
  return reference.slice(dot + 1);
};

const finish = (builder: Builder): string => {
  builder.finishUsed = true;
  return finishNodeAlias;
};

/** Whether nothing can run after this task, so a following task could never be reached. */
const endsTheRule = (task: SourceFlowTask): boolean =>
  task.type === "stop" || task.type === "rule.refuse";

/**
 * Builds the nodes for a list of tasks that continue at `next` and returns the alias of the first
 * one. Building from the last task back keeps every task's continuation known when it is added.
 */
const buildList = (
  builder: Builder,
  tasks: readonly SourceFlowTask[],
  next: string,
  path: Path,
): string => {
  let entry = next;
  for (let index = tasks.length - 1; index >= 0; index -= 1) {
    const task = tasks[index]!;
    if (endsTheRule(task) && index < tasks.length - 1) return unsupported([...path, index + 1]);
    entry = buildTask(builder, task, entry, [...path, index]);
  }
  return entry;
};

/** Builds one task, locating a refusal inside it on the innermost task that caused it. */
const buildTask = (builder: Builder, task: SourceFlowTask, next: string, path: Path): string => {
  try {
    return buildTaskNodes(builder, task, next, path);
  } catch (error) {
    if (error instanceof Refused && error.refusal.taskId === undefined)
      throw new Refused({ ...error.refusal, taskId: task.id });
    throw error;
  }
};

const buildTaskNodes = (
  builder: Builder,
  task: SourceFlowTask,
  next: string,
  path: Path,
): string => {
  if (task.retry !== undefined || task.timeout !== undefined) return unsupported(path);
  const alias = taskNodeAlias(task.id);
  switch (task.type) {
    case "if": {
      const node = task as Extract<SourceFlowTask, { type: "if" }>;
      const whenTrue = buildList(builder, node.then, next, [...path, "then"]);
      const whenFalse =
        node.else === undefined ? next : buildList(builder, node.else, next, [...path, "else"]);
      builder.nodes.push({
        id: alias,
        ...nodeBase,
        type: "condition",
        condition: condition(node.condition, [...path, "condition"]),
      });
      builder.edges.push(
        { from: alias, port: "true", to: whenTrue },
        { from: alias, port: "false", to: whenFalse },
      );
      return alias;
    }
    case "stop":
      return finish(builder);
    case "rule.require":
    case "rule.warn":
    case "rule.refuse": {
      const registered = task as Extract<SourceFlowTask, { properties: unknown }>;
      if (registered.allowRefusal === true) return unsupported([...path, "allowRefusal"]);
      const properties = registered.properties;
      const message = required(textOf(properties.message, [...path, "properties", "message"]), [
        ...path,
        "properties",
        "message",
      ]);
      if (task.type === "rule.refuse") {
        const field =
          properties.field === undefined
            ? undefined
            : fieldAlias(builder, properties.field, [...path, "properties", "field"]);
        builder.nodes.push({
          id: alias,
          ...nodeBase,
          type: "refuse",
          code: required(textOf(properties.reason, [...path, "properties", "reason"]), [
            ...path,
            "properties",
            "reason",
          ]),
          message,
          ...(field === undefined ? {} : { field }),
        });
        // A refusal ends the rule; nothing continues from it.
        return alias;
      }
      if (task.type === "rule.warn") {
        // A warning names no field in a rule graph, so one that names a field cannot be lowered.
        if (properties.field !== undefined) return unsupported([...path, "properties", "field"]);
        builder.nodes.push({ id: alias, ...nodeBase, type: "warn", code: task.id, message });
      } else
        builder.nodes.push({
          id: alias,
          ...nodeBase,
          type: "require_field",
          field: fieldAlias(builder, properties.field, [...path, "properties", "field"]),
          code: task.id,
          message,
        });
      builder.edges.push({ from: alias, port: "next", to: next });
      return alias;
    }
    default:
      return unsupported([...path, "type"]);
  }
};

// ─── The flow ────────────────────────────────────────────────────────────────────────────────

/**
 * Lowers one `BeforeSave` flow to its rule graph, or reports the first thing that cannot be
 * lowered. Nothing is thrown: callers that only list identities ignore a refusal, and the compiler
 * turns it into a located refusal.
 */
export const lowerBeforeSaveFlow = (flow: SourceFlow): BeforeSaveLowering => {
  try {
    const trigger = flow.triggers[0];
    if (flow.triggers.length !== 1 || trigger?.type !== "BeforeSave") return unsupported(["triggers"]);
    if (Object.keys(trigger.inputs).length > 0) return unsupported(["triggers", 0, "inputs"]);
    if (Object.keys(flow.inputs).length > 0) return unsupported(["inputs"]);
    if (Object.keys(flow.variables).length > 0) return unsupported(["variables"]);
    if (Object.keys(flow.outputs).length > 0) return unsupported(["outputs"]);
    if (flow.errors.length > 0) return unsupported(["errors"]);
    if (flow.finally.length > 0) return unsupported(["finally"]);
    if (
      flow.retry !== undefined ||
      flow.timeout !== undefined ||
      flow.concurrency !== undefined ||
      flow.invocationPermissionId !== undefined
    )
      return unsupported(["triggers"]);
    // A rule graph covers only the two ordinary saves; a transition has its own action.
    const operations: ("create" | "update")[] = [];
    trigger.operations.forEach((operation, index) => {
      if (operation.kind === "transition") return unsupported(["triggers", 0, "operations", index]);
      operations.push(operation.kind);
    });
    // Only a record type of this Module, written as its bare alias, has fields a rule can read.
    if (!/^[a-z][a-z0-9_]*$/.test(trigger.recordTypeId))
      return invalidValue(["triggers", 0, "recordTypeId"]);

    const builder: Builder = {
      nodes: [],
      edges: [],
      recordType: trigger.recordTypeId,
      finishUsed: false,
    };
    const finishAlias = finishNodeAlias;
    // The entry condition, when present, guards the whole task list.
    let entry: string;
    if (trigger.condition === undefined)
      entry = buildList(builder, flow.tasks, finishAlias, ["tasks"]);
    else {
      const body = buildList(builder, flow.tasks, finishAlias, ["tasks"]);
      const guard = "trigger_condition";
      builder.nodes.push({
        id: guard,
        ...nodeBase,
        type: "condition",
        condition: condition(trigger.condition, ["triggers", 0, "condition"]),
      });
      builder.edges.push(
        { from: guard, port: "true", to: body },
        { from: guard, port: "false", to: finishAlias },
      );
      entry = guard;
    }
    // Whether the shared finish node is reached is known only once every branch is built.
    const reachesFinish = builder.edges.some((edge) => edge.to === finishAlias) || entry === finishAlias;
    builder.nodes.push({
      id: startNodeAlias,
      ...nodeBase,
      type: "start",
      operations: [...new Set(operations)].sort(),
    });
    builder.edges.push({ from: startNodeAlias, port: "next", to: entry });
    if (reachesFinish || builder.finishUsed)
      builder.nodes.push({ id: finishNodeAlias, ...nodeBase, type: "finish" });

    const graph = sourceRuleGraphSchema.safeParse({
      id: flow.id,
      key: flow.key,
      record_type: trigger.recordTypeId,
      profile: "before_save",
      graph_version: "1.0.0",
      priority: trigger.priority,
      inputs: [],
      variables: [],
      nodes: builder.nodes,
      edges: builder.edges,
    });
    if (!graph.success) return invalidValue([]);
    return { ok: true, graph: graph.data };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, refusal: error.refusal };
    throw error;
  }
};
