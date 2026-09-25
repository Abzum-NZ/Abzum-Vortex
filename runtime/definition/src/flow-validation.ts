import {
  flowLiteralSchema,
  flowMaximumForEachItemsDurable,
  flowMaximumForEachItemsOther,
  flowMaximumServerSeconds,
  flowMaximumTaskCount,
  flowMaximumTaskNestingDepth,
  flowTaskChildLists,
  flowTaskRegistry,
  flowTriggerExecutionKinds,
  isFlowControlTask,
  validateFlowCallGraph,
  validateFlowTaskPlacement,
  valueTypesCompatible,
  type DefinitionRuleFailureFamily,
  type DefinitionValidationLocation,
  type FlowDefinition,
  type FlowFormula,
  type FlowReference,
  type FlowSource,
  type FlowTask,
  type FlowTaskPlacementIssue,
  type FlowTaskTypeDefinition,
  type FlowValue,
  type SourceFlow,
} from "@vortex/contracts";
import type { DefinitionCompilerRefusalCode } from "./compilation-error";

/**
 * The one flow validator (issue #985). It replaces the free-graph validators (rule graphs,
 * frontend flow routing, workflow reachability and the Kestra compiler's repeats) for the single
 * flow language. A flow is a nested task list, so scope is the nesting itself: no cycle,
 * dominator or reachability analysis exists here or is needed.
 *
 * It checks, for one flow at a time:
 * - structure and limits that are decidable from the flow: task identity, count and nesting,
 *   triggers against the execution kind, run as, policies, and typed declarations;
 * - every task's run location against the flow's execution kind, by the task registry's own
 *   `validateFlowTaskPlacement`, which stays the one placement rule;
 * - every typed reference: it must name a declared input or variable, a record trigger, or the
 *   output of a task that has already run in scope, and its type must fit where it is used, by
 *   the one value-type compatibility function (`valueTypesCompatible`, the `flow` context);
 * - outputs and error handling: an output's value must fit its declared type, and `outcome` is
 *   readable only from a task that sets `allowRefusal`.
 *
 * Nothing here requires a refused, validation, conflict or uncertain result to be routed. The
 * default error handler presents those results safely, and `errors` only adds behaviour.
 *
 * The validator reads a flow in either shape: the authored source (readable aliases) or the
 * canonical flow (permanent identities). It never resolves an alias, so it invents no identity.
 * It returns every issue with a path relative to the flow; callers place them on the definition.
 */

type Path = (string | number)[];

export type FlowValidationIssue = Readonly<{
  /** Path inside the flow, for example `["tasks", 1, "then", 0, "properties", "message"]`. */
  path: Path;
  ruleCode: DefinitionCompilerRefusalCode;
  family: DefinitionRuleFailureFamily;
  message: string;
  /** The innermost task the path passes through, so a refusal can be placed on that node. */
  taskId?: string;
}>;

export type FlowSetValidationIssue = FlowValidationIssue & Readonly<{ flowId: string }>;

export type FlowValidationOptions = Readonly<{
  /**
   * The other flows the same owner compiles, in either shape. `run_flow` and
   * `flow.run_background` are checked against a target found here by its `id` or `key`; a target
   * that is not here belongs to a dependency and is checked when the dependency is compiled.
   */
  siblingFlows?: readonly (FlowDefinition | FlowSource | SourceFlow)[];
}>;

const placementCodes: Readonly<
  Record<
    FlowTaskPlacementIssue["code"],
    readonly [DefinitionCompilerRefusalCode, DefinitionRuleFailureFamily]
  >
> = {
  unknown_task_type: ["vortex.definition.unsupported_workflow_node", "unsupported_choice"],
  unsupported_task_version: ["vortex.definition.incompatible_version", "incompatible_version"],
  wrong_run_location: ["vortex.definition.workflow_node_references", "invalid_value"],
  unknown_property: ["vortex.definition.workflow_node_values", "unknown_property"],
  missing_property: ["vortex.definition.workflow_node_values", "required_value"],
  saved_record_target: ["vortex.definition.workflow_node_values", "invalid_value"],
  refusal_not_possible: ["vortex.definition.workflow_node_values", "invalid_value"],
};

const callCodes = {
  cycle: ["vortex.definition.workflow_child_acyclic", "dependency_cycle"],
  depth_exceeded: ["vortex.definition.workflow_child_depth", "too_many_items"],
  transaction_calls_non_transaction: ["vortex.definition.workflow_child_reference", "invalid_value"],
} as const satisfies Record<
  string,
  readonly [DefinitionCompilerRefusalCode, DefinitionRuleFailureFamily]
>;

// ─── Value types ───────────────────────────────────────────────────────────────────────────────

/** The static type of a value, or `undefined` when only the runtime evaluator can know it. */
type StaticType = string | undefined;

const numericTypes: ReadonlySet<string> = new Set(["whole_number", "decimal_number", "money"]);
const dateTypes: ReadonlySet<string> = new Set(["date", "date_time"]);
const listTypes: ReadonlySet<string> = new Set([
  "record_reference_list",
  "relationship_reference_list",
  "several_choices",
]);

/**
 * The types a property accepts, or `undefined` when it takes any value. Identity, key and formula
 * properties are decided by their own rules in `checkProperty`.
 */
const acceptedTypes = (propertyType: string): readonly string[] | undefined => {
  switch (propertyType) {
    case "any_value":
    case "input_map":
    case "field_values":
    case "record_change_list":
    case "json":
      return undefined;
    case "message_text":
      return ["text", "formatted_text"];
    default:
      return [propertyType];
  }
};

const literalOnlyPropertyTypes: ReadonlySet<string> = new Set([
  "record_type_id",
  "field_id",
  "relationship_id",
  "query_id",
  "page_id",
  "form_id",
  "connection_binding_id",
  "protected_operation_key",
  "flow_id",
  "builder_key",
  "namespaced_key",
]);

/** A value whose type is only known at run time (`json`) is checked by the evaluator, not here. */
const fits = (actual: StaticType, accepted: readonly string[] | undefined): boolean =>
  accepted === undefined ||
  actual === undefined ||
  actual === "json" ||
  accepted.some((expected) => valueTypesCompatible(actual, expected, "flow"));

const describe = (accepted: readonly string[]): string => accepted.join(" or ");

const isTextLiteral = (value: FlowValue): boolean =>
  value.kind === "literal" && value.literal.type === "text" && typeof value.literal.value === "string";

// ─── The validator ─────────────────────────────────────────────────────────────────────────────

type Scope = Map<string, FlowTask>;

export function validateFlow(
  flowInput: FlowDefinition | FlowSource | SourceFlow,
  options: FlowValidationOptions = {},
): FlowValidationIssue[] {
  const flow = flowInput as unknown as FlowSource;
  const issues: FlowValidationIssue[] = [];
  const add = (
    path: Path,
    ruleCode: DefinitionCompilerRefusalCode,
    family: DefinitionRuleFailureFamily,
    message: string,
  ) => issues.push({ path, ruleCode, family, message });

  const timeAllowed = flow.execution === "interactive" || flow.execution === "background";

  // ── Run locations, task types, versions and properties: the registry's own placement check. ──
  for (const placement of validateFlowTaskPlacement(flow)) {
    const [ruleCode, family] = placementCodes[placement.code];
    add(placement.path, ruleCode, family, placement.message);
  }

  // ── Structure and limits. ──
  validateStructure(flow, add);

  // ── Declarations. ──
  const inputTypes = new Map<string, StaticType>();
  const variableTypes = new Map<string, StaticType>();
  const declare = (
    declarations: Readonly<Record<string, DeclarationView>>,
    into: Map<string, StaticType>,
    path: Path,
  ) => {
    for (const [name, declaration] of Object.entries(declarations)) {
      checkDeclaration(declaration, [...path, name], add);
      // A name declared twice with different types has no single static type.
      into.set(name, into.has(name) && into.get(name) !== declaration.type ? undefined : declaration.type);
    }
  };
  declare(flow.inputs, inputTypes, ["inputs"]);
  // A trigger supplies typed values of its own; `inputs.x` may name one of them.
  flow.triggers.forEach((trigger, index) =>
    declare(trigger.inputs, inputTypes, ["triggers", index, "inputs"]),
  );
  declare(flow.variables, variableTypes, ["variables"]);

  const hasRecordTrigger = flow.triggers.some(
    (trigger) => trigger.type === "BeforeSave" || trigger.type === "Event",
  );

  // ── Typed references. ──
  type Where = { nowAllowed: boolean; scope: ReadonlyMap<string, FlowTask>; triggerOnly: boolean };

  const outputType = (task: FlowTask, key: string, siblings: ReadonlyMap<string, FlowSource>) => {
    if (task.type === "run_flow") {
      const target = siblings.get((task as { flowId: string }).flowId);
      if (target === undefined) return { known: true as const, type: undefined };
      const declared = Object.hasOwn(target.outputs, key) ? target.outputs[key] : undefined;
      return declared === undefined
        ? { known: false as const }
        : { known: true as const, type: declared.type as StaticType };
    }
    // The person's answers have no declared shape until the form contract types them.
    if (task.type === "wait_for_person") return { known: true as const, type: undefined };
    if (isFlowControlTask(task)) return { known: false as const };
    const registered = task as Extract<FlowTask, { properties: unknown }>;
    if (key === "outcome" && registered.allowRefusal === true)
      return { known: true as const, type: "choice" as StaticType };
    const definition: FlowTaskTypeDefinition | undefined = Object.hasOwn(flowTaskRegistry, task.type)
      ? flowTaskRegistry[task.type as keyof typeof flowTaskRegistry]
      : undefined;
    // An unregistered type is already refused by the placement check.
    if (definition === undefined) return { known: true as const, type: undefined };
    const declared = definition.outputs.find((output) => output.key === key);
    return declared === undefined
      ? { known: false as const }
      : { known: true as const, type: declared.type as StaticType };
  };

  const siblings = new Map<string, FlowSource>();
  for (const other of options.siblingFlows ?? []) {
    const view = other as unknown as FlowSource;
    siblings.set(view.id, view);
    siblings.set(view.key, view);
  }

  const allTasks = new Map<string, FlowTask>();
  const collect = (tasks: readonly FlowTask[]) => {
    for (const task of tasks) {
      allTasks.set(task.id, task);
      for (const child of flowTaskChildLists(task)) collect(child.tasks);
    }
  };
  collect(flow.tasks);
  collect(flow.errors);
  collect(flow.finally);

  const resolveReference = (reference: FlowReference, where: Where, path: Path): StaticType => {
    switch (reference.source) {
      case "input":
        if (!inputTypes.has(reference.name)) {
          add(
            path,
            "vortex.definition.workflow_node_references",
            "broken_reference",
            `The flow declares no input named ${reference.name}`,
          );
          return undefined;
        }
        return inputTypes.get(reference.name);
      case "variable":
        if (where.triggerOnly || !variableTypes.has(reference.name)) {
          add(
            path,
            "vortex.definition.workflow_node_references",
            "broken_reference",
            where.triggerOnly
              ? "A trigger condition cannot read variables"
              : `The flow declares no variable named ${reference.name}`,
          );
          return undefined;
        }
        return variableTypes.get(reference.name);
      case "trigger_record":
      case "trigger_previous":
        if (!hasRecordTrigger)
          add(
            path,
            "vortex.definition.trigger_record_required",
            "required_value",
            "Only a flow with a BeforeSave or Event trigger has a trigger record",
          );
        // A record field's type belongs to the record type, which the flow does not carry.
        return undefined;
      case "execution_actor":
        return "organization_account_reference";
      case "execution_now":
        return "date_time";
      case "task_output": {
        if (where.triggerOnly) {
          add(
            path,
            "vortex.definition.workflow_node_references",
            "broken_reference",
            "A trigger condition cannot read task outputs",
          );
          return undefined;
        }
        const task = where.scope.get(reference.task);
        if (task === undefined) {
          if (allTasks.has(reference.task))
            add(
              path,
              "vortex.definition.workflow_output_dominates",
              "scope_conflict",
              `Task ${reference.task} has not necessarily run here; only earlier tasks in the same or an enclosing list can be read`,
            );
          else
            add(
              path,
              "vortex.definition.workflow_output_exists",
              "broken_reference",
              `The flow has no task ${reference.task}`,
            );
          return undefined;
        }
        const output = outputType(task, reference.key, siblings);
        if (!output.known) {
          add(
            path,
            "vortex.definition.workflow_output_exists",
            "broken_reference",
            reference.key === "outcome"
              ? `Task ${reference.task} can be branched on only when it sets allowRefusal`
              : `Task ${reference.task} has no output ${reference.key}`,
          );
          return undefined;
        }
        return output.type;
      }
    }
  };

  const formulaType = (formula: FlowFormula, where: Where, path: Path): StaticType => {
    const child = (value: FlowFormula, ...segments: (string | number)[]) =>
      formulaType(value, where, [...path, ...segments]);
    const expect = (
      actual: StaticType,
      accepted: (type: string) => boolean,
      childPath: Path,
      wanted: string,
    ) => {
      if (actual === undefined || actual === "json" || accepted(actual)) return;
      add(
        childPath,
        "vortex.definition.source_type_compatibility",
        "invalid_value",
        `Expected ${wanted}, found ${actual}`,
      );
    };
    const numericArgs = (args: readonly FlowFormula[], segment: string): StaticType => {
      const types = args.map((arg, index) => {
        const type = child(arg, segment, index);
        expect(type, (candidate) => numericTypes.has(candidate), [...path, segment, index], "a number");
        return type;
      });
      return types.includes("money")
        ? "money"
        : types.some((type) => type === undefined || type === "json")
          ? undefined
          : types.includes("decimal_number")
            ? "decimal_number"
            : "whole_number";
    };
    switch (formula.op) {
      case "literal":
        return formula.type;
      case "reference":
        return resolveReference(formula.reference, where, [...path, "reference"]);
      case "now":
        if (!where.nowAllowed)
          add(
            path,
            "vortex.definition.workflow_node_values",
            "invalid_value",
            "The now operator is allowed only in interactive and background flows, and never in a trigger",
          );
        return "date_time";
      case "add":
      case "multiply":
      case "subtract":
        return numericArgs(formula.args, "args");
      case "divide": {
        const type = numericArgs(formula.args, "args");
        return type === "money" ? "money" : type === undefined ? undefined : "decimal_number";
      }
      case "round": {
        const type = child(formula.arg, "arg");
        expect(type, (candidate) => numericTypes.has(candidate), [...path, "arg"], "a number");
        return type;
      }
      case "eq":
      case "neq":
      case "lt":
      case "lte":
      case "gt":
      case "gte":
      case "contains":
      case "starts_with":
      case "ends_with": {
        const left = child(formula.left, "left");
        const right = child(formula.right, "right");
        if (
          left !== undefined &&
          right !== undefined &&
          left !== "json" &&
          right !== "json" &&
          !valueTypesCompatible(left, right, "condition") &&
          !valueTypesCompatible(right, left, "condition")
        )
          add(
            path,
            "vortex.definition.source_type_compatibility",
            "invalid_value",
            `Cannot compare ${left} with ${right}`,
          );
        return "yes_no";
      }
      case "is_empty":
      case "is_not_empty":
        child(formula.arg, "arg");
        return "yes_no";
      case "in": {
        const value = child(formula.value, "value");
        formula.options.forEach((option, index) => {
          const type = child(option, "options", index);
          if (
            value !== undefined &&
            type !== undefined &&
            value !== "json" &&
            type !== "json" &&
            !valueTypesCompatible(type, value, "condition")
          )
            add(
              [...path, "options", index],
              "vortex.definition.source_type_compatibility",
              "invalid_value",
              `An option of type ${type} cannot be compared with ${value}`,
            );
        });
        return "yes_no";
      }
      case "and":
      case "or":
        formula.args.forEach((arg, index) =>
          expect(child(arg, "args", index), (type) => type === "yes_no", [...path, "args", index], "a yes/no value"),
        );
        return "yes_no";
      case "not":
        expect(child(formula.arg, "arg"), (type) => type === "yes_no", [...path, "arg"], "a yes/no value");
        return "yes_no";
      case "if": {
        expect(
          child(formula.condition, "condition"),
          (type) => type === "yes_no",
          [...path, "condition"],
          "a yes/no value",
        );
        const then = child(formula.then, "then");
        const otherwise = child(formula.else, "else");
        return then === otherwise ? then : undefined;
      }
      case "join":
        formula.parts.forEach((part, index) => child(part, "parts", index));
        return "text";
      case "date_add": {
        const date = child(formula.date, "date");
        expect(date, (type) => dateTypes.has(type), [...path, "date"], "a date or date and time");
        expect(
          child(formula.amount, "amount"),
          (type) => type === "whole_number",
          [...path, "amount"],
          "a whole number",
        );
        return date;
      }
      case "date_diff":
        expect(child(formula.from, "from"), (type) => dateTypes.has(type), [...path, "from"], "a date or date and time");
        expect(child(formula.to, "to"), (type) => dateTypes.has(type), [...path, "to"], "a date or date and time");
        return "whole_number";
    }
  };

  const valueType = (value: FlowValue, where: Where, path: Path): StaticType => {
    switch (value.kind) {
      case "literal":
        return value.literal.type;
      case "reference":
        return resolveReference(value.reference, where, [...path, "reference"]);
      case "formula":
        return formulaType(value.formula, where, [...path, "formula"]);
    }
  };

  /** Checks a value against the types its use accepts; `undefined` accepts any value. */
  const checkValue = (
    value: FlowValue,
    accepted: readonly string[] | undefined,
    where: Where,
    path: Path,
  ) => {
    const actual = valueType(value, where, path);
    if (accepted === undefined || actual === undefined) return;
    const literal = value.kind === "literal";
    if (literal ? accepted.some((expected) => valueTypesCompatible(actual, expected, "value")) : fits(actual, accepted))
      return;
    add(
      path,
      "vortex.definition.source_type_compatibility",
      "invalid_value",
      `Expected ${describe(accepted)}, found ${actual}`,
    );
  };

  const checkInputMap = (
    values: Readonly<Record<string, FlowValue>>,
    target: FlowSource | undefined,
    where: Where,
    path: Path,
  ) => {
    for (const [name, value] of Object.entries(values)) {
      const declared =
        target !== undefined && Object.hasOwn(target.inputs, name) ? target.inputs[name] : undefined;
      if (target !== undefined && declared === undefined)
        add(
          [...path, name],
          "vortex.definition.workflow_node_values",
          "unknown_property",
          `The target flow declares no input named ${name}`,
        );
      checkValue(value, declared === undefined ? undefined : [declared.type], where, [...path, name]);
    }
    if (target !== undefined)
      for (const [name, declared] of Object.entries(target.inputs))
        if (declared.required && !Object.hasOwn(values, name))
          add(
            [...path, name],
            "vortex.definition.workflow_node_values",
            "required_value",
            `The target flow requires the input ${name}`,
          );
  };

  const checkProperty = (
    task: Extract<FlowTask, { properties: unknown }>,
    definition: FlowTaskTypeDefinition,
    name: string,
    value: FlowValue,
    where: Where,
    path: Path,
  ) => {
    const declared = Object.hasOwn(definition.properties, name)
      ? definition.properties[name]
      : undefined;
    // An undeclared property is refused by the placement check; its references still resolve.
    if (declared === undefined) {
      valueType(value, where, path);
      return;
    }
    if (declared.type === "formula") {
      if (value.kind !== "formula")
        add(path, "vortex.definition.workflow_node_values", "invalid_value", `${name} must be a formula`);
      else formulaType(value.formula, where, [...path, "formula"]);
      return;
    }
    if (literalOnlyPropertyTypes.has(declared.type)) {
      if (!isTextLiteral(value))
        add(
          path,
          "vortex.definition.workflow_node_values",
          "invalid_value",
          `${name} must be written as a readable name, never computed`,
        );
      return;
    }
    checkValue(value, acceptedTypes(declared.type), where, path);
    if (task.type === "data.set_variable" && name === "value") {
      const variable = task.properties.variable;
      if (variable !== undefined && isTextLiteral(variable)) {
        const target = String((variable as { literal: { value: unknown } }).literal.value);
        if (!variableTypes.has(target))
          add(
            [...path.slice(0, -1), "variable"],
            "vortex.definition.workflow_node_references",
            "broken_reference",
            `The flow declares no variable named ${target}`,
          );
        else {
          const variableType = variableTypes.get(target);
          checkValue(value, variableType === undefined ? undefined : [variableType], where, path);
        }
      }
    }
    if (
      task.type === "flow.run_background" &&
      name === "flow" &&
      isTextLiteral(value)
    ) {
      const target = siblings.get(String((value as { literal: { value: unknown } }).literal.value));
      if (target !== undefined && target.execution !== "background" && target.execution !== "durable")
        add(
          path,
          "vortex.definition.workflow_child_reference",
          "invalid_value",
          "Run background flow starts only a background or durable flow",
        );
    }
  };

  const checkTask = (task: FlowTask, path: Path, scope: Scope) => {
    const where: Where = { nowAllowed: timeAllowed, scope, triggerOnly: false };
    switch (task.type) {
      case "if": {
        const node = task as Extract<FlowTask, { type: "if" }>;
        const type = formulaType(node.condition, where, [...path, "condition"]);
        if (type !== undefined && type !== "json" && type !== "yes_no")
          add([...path, "condition"], "vortex.definition.source_type_compatibility", "invalid_value", `A condition must be a yes/no value, found ${type}`);
        return;
      }
      case "switch": {
        const node = task as Extract<FlowTask, { type: "switch" }>;
        const type = valueType(node.value, where, [...path, "value"]);
        node.cases.forEach((entry, index) => {
          if (
            type !== undefined &&
            type !== "json" &&
            !valueTypesCompatible(entry.when.type, type, "condition")
          )
            add(
              [...path, "cases", index, "when"],
              "vortex.definition.source_type_compatibility",
              "invalid_value",
              `A case of type ${entry.when.type} cannot match a ${type} value`,
            );
        });
        return;
      }
      case "for_each": {
        const node = task as Extract<FlowTask, { type: "for_each" }>;
        const type = valueType(node.items, where, [...path, "items"]);
        if (type !== undefined && type !== "json" && !listTypes.has(type))
          add([...path, "items"], "vortex.definition.source_type_compatibility", "invalid_value", `For each needs a list, found ${type}`);
        return;
      }
      case "run_flow": {
        const node = task as Extract<FlowTask, { type: "run_flow" }>;
        checkInputMap(node.inputs, siblings.get(node.flowId as string), where, [...path, "inputs"]);
        return;
      }
      case "wait_until": {
        const node = task as Extract<FlowTask, { type: "wait_until" }>;
        checkValue(node.until, ["date_time", "date"], where, [...path, "until"]);
        return;
      }
      case "wait_for_person": {
        const node = task as Extract<FlowTask, { type: "wait_for_person" }>;
        checkValue(node.assignee, ["organization_account_reference"], where, [...path, "assignee"]);
        for (const [name, value] of Object.entries(node.inputs))
          valueType(value, where, [...path, "inputs", name]);
        return;
      }
      case "sequential":
      case "parallel":
      case "stop":
        return;
      default: {
        const node = task as Extract<FlowTask, { properties: unknown }>;
        const definition = Object.hasOwn(flowTaskRegistry, node.type)
          ? flowTaskRegistry[node.type as keyof typeof flowTaskRegistry]
          : undefined;
        for (const [name, value] of Object.entries(node.properties)) {
          const propertyPath = [...path, "properties", name];
          if (definition === undefined) valueType(value, where, propertyPath);
          else checkProperty(node, definition, name, value, where, propertyPath);
        }
      }
    }
  };

  /**
   * Walks a list in order. A task sees the outputs of every earlier task of its own list and of
   * the lists that enclose it. Tasks inside a branch, iteration or parallel branch are not visible
   * after it, because they have not necessarily run; a sequential group is transparent.
   */
  const walk = (tasks: readonly FlowTask[], path: Path, scope: Scope) => {
    tasks.forEach((task, index) => {
      const taskPath = [...path, index];
      checkTask(task, taskPath, scope);
      for (const child of flowTaskChildLists(task)) {
        walk(child.tasks, [...taskPath, ...child.path], task.type === "sequential" ? scope : new Map(scope));
      }
      scope.set(task.id, task);
    });
  };

  const mainScope: Scope = new Map();
  walk(flow.tasks, ["tasks"], mainScope);

  // Error handling reads what the failed run produced; `finally` also reads what errors did.
  // Either can run after any task, so every main task is nameable, and its type still checks.
  const handlerScope = (): Scope => new Map(allTasksIn(flow.tasks));
  walk(flow.errors, ["errors"], handlerScope());
  const finallyScope = handlerScope();
  for (const [id, task] of allTasksIn(flow.errors)) finallyScope.set(id, task);
  walk(flow.finally, ["finally"], finallyScope);

  // Triggers: an entry condition reads only the trigger's own values and the record.
  flow.triggers.forEach((trigger, index) => {
    if (trigger.condition === undefined) return;
    const type = formulaType(
      trigger.condition,
      { nowAllowed: false, scope: new Map(), triggerOnly: true },
      ["triggers", index, "condition"],
    );
    if (type !== undefined && type !== "json" && type !== "yes_no")
      add(["triggers", index, "condition"], "vortex.definition.source_type_compatibility", "invalid_value", `A condition must be a yes/no value, found ${type}`);
  });

  // Outputs: each value must fit its declared type, and may read every task that surely ran.
  for (const [name, output] of Object.entries(flow.outputs)) {
    checkValue(
      output.value,
      [output.type],
      { nowAllowed: timeAllowed, scope: mainScope, triggerOnly: false },
      ["outputs", name, "value"],
    );
  }

  return issues.map((issue) => {
    const taskId = taskIdAtPath(flow, issue.path);
    return taskId === undefined ? issue : { ...issue, taskId };
  });
}

/** Every task of a list and its nested lists, keyed by task id. */
const allTasksIn = (tasks: readonly FlowTask[]): Map<string, FlowTask> => {
  const found = new Map<string, FlowTask>();
  const visit = (list: readonly FlowTask[]) => {
    for (const task of list) {
      found.set(task.id, task);
      for (const child of flowTaskChildLists(task)) visit(child.tasks);
    }
  };
  visit(tasks);
  return found;
};

const taskIdAtPath = (flow: unknown, path: Path): string | undefined => {
  if (path[0] !== "tasks" && path[0] !== "errors" && path[0] !== "finally") return undefined;
  let current: unknown = flow;
  let taskId: string | undefined;
  for (const segment of path) {
    if (current === null || typeof current !== "object") break;
    current = (current as Record<string | number, unknown>)[segment];
    if (
      current !== null &&
      typeof current === "object" &&
      typeof (current as { id?: unknown }).id === "string" &&
      typeof (current as { type?: unknown }).type === "string"
    )
      taskId = (current as { id: string }).id;
  }
  return taskId;
};

// ─── Declarations ──────────────────────────────────────────────────────────────────────────────

type DeclarationView = Readonly<{
  type: string;
  recordTypeIds?: readonly string[] | undefined;
  default?: unknown;
  required?: boolean;
}>;

type Add = (
  path: Path,
  ruleCode: DefinitionCompilerRefusalCode,
  family: DefinitionRuleFailureFamily,
  message: string,
) => void;

const checkDeclaration = (declaration: DeclarationView, path: Path, add: Add) => {
  const recordReference =
    declaration.type === "record_reference" || declaration.type === "record_reference_list";
  if (recordReference !== (declaration.recordTypeIds !== undefined))
    add(
      [...path, "recordTypeIds"],
      "vortex.definition.workflow_node_values",
      recordReference ? "required_value" : "invalid_value",
      "Record-reference values, and only they, name their allowed record types",
    );
  if (
    declaration.recordTypeIds !== undefined &&
    new Set(declaration.recordTypeIds).size !== declaration.recordTypeIds.length
  )
    add(
      [...path, "recordTypeIds"],
      "vortex.definition.workflow_node_values",
      "duplicate_key",
      "Allowed record types must be unique",
    );
  if (declaration.default !== undefined) {
    if (declaration.required === true)
      add(
        [...path, "default"],
        "vortex.definition.workflow_node_values",
        "invalid_value",
        "A required input cannot declare a default",
      );
    else if (
      !flowLiteralSchema.safeParse({ type: declaration.type, value: declaration.default }).success
    )
      add(
        [...path, "default"],
        "vortex.definition.source_type_compatibility",
        "invalid_value",
        `The default does not match the ${declaration.type} type`,
      );
  }
};

// ─── Structure and limits ──────────────────────────────────────────────────────────────────────

const validateStructure = (flow: FlowSource, add: Add) => {
  const durable = flow.execution === "durable";
  const source = "vortex.definition.source_shape" as const;

  for (const name of Object.keys(flow.variables))
    if (Object.hasOwn(flow.inputs, name))
      add(["variables", name], source, "duplicate_key", "A variable cannot reuse the name of an input");

  // Triggers must fit the execution kind, which the flow has exactly one of.
  if (flow.execution === "interactive" && flow.triggers.length > 0)
    add(
      ["triggers"],
      "vortex.definition.unsupported_workflow_trigger",
      "unsupported_choice",
      "An interactive flow starts only through bindings, never a trigger",
    );
  const triggerIds = new Set<string>();
  flow.triggers.forEach((trigger, index) => {
    if (triggerIds.has(trigger.id))
      add(["triggers", index, "id"], source, "duplicate_key", "Trigger ids must be unique");
    triggerIds.add(trigger.id);
    if (!(flowTriggerExecutionKinds[trigger.type] as readonly string[]).includes(flow.execution))
      add(
        ["triggers", index, "type"],
        "vortex.definition.unsupported_workflow_trigger",
        "unsupported_choice",
        `A ${trigger.type} trigger cannot start a ${flow.execution} flow`,
      );
  });

  // Run as follows from the execution kind and how the flow starts.
  const systemStarted = flow.triggers.some(
    (trigger) => trigger.type === "Schedule" || trigger.type === "IncomingMessage",
  );
  const allowedRunAs: readonly string[] =
    flow.execution === "interactive"
      ? ["initiator"]
      : flow.execution === "transaction"
        ? ["saver"]
        : flow.execution === "background" || systemStarted
          ? ["specified_account", "system"]
          : ["initiator"];
  if (!allowedRunAs.includes(flow.runAs.kind))
    add(
      ["runAs", "kind"],
      "vortex.definition.workflow_permission",
      "invalid_value",
      `A ${flow.execution} flow cannot run as ${flow.runAs.kind}`,
    );

  // Policies: retries and long timeouts belong to durable flows.
  if (!durable && flow.retry !== undefined)
    add(["retry"], source, "invalid_value", "Retries are allowed only in durable flows");
  if (!durable && flow.timeout !== undefined && flow.timeout.seconds > flowMaximumServerSeconds)
    add(["timeout", "seconds"], source, "invalid_value", `Only durable flows may time out after more than ${flowMaximumServerSeconds} seconds`);
  if (flow.concurrency !== undefined && flow.execution !== "durable" && flow.execution !== "background")
    add(["concurrency"], source, "invalid_value", "Concurrency limits apply only to background and durable flows");

  // Tasks: identity, count, nesting and per-task limits.
  const seen = new Set<string>();
  let count = 0;
  const forEachMaximum = durable ? flowMaximumForEachItemsDurable : flowMaximumForEachItemsOther;
  const visit = (tasks: readonly FlowTask[], path: Path, depth: number) => {
    tasks.forEach((task, index) => {
      const taskPath = [...path, index];
      count += 1;
      if (depth > flowMaximumTaskNestingDepth)
        add(taskPath, source, "too_many_items", `Tasks cannot nest deeper than ${flowMaximumTaskNestingDepth} levels`);
      if (seen.has(task.id)) add([...taskPath, "id"], source, "duplicate_key", "Task ids must be unique in a flow");
      seen.add(task.id);
      if (!durable && task.retry !== undefined)
        add([...taskPath, "retry"], source, "invalid_value", "Retries are allowed only in durable flows");
      if (!durable && task.timeout !== undefined && task.timeout.seconds > flowMaximumServerSeconds)
        add([...taskPath, "timeout", "seconds"], source, "invalid_value", `Only durable flows may time out after more than ${flowMaximumServerSeconds} seconds`);
      if (task.type === "for_each" && (task as { maximumItems: number }).maximumItems > forEachMaximum)
        add([...taskPath, "maximumItems"], source, "too_many_items", `For each allows at most ${forEachMaximum.toLocaleString("en-NZ")} items in ${durable ? "durable" : "non-durable"} flows`);
      for (const child of flowTaskChildLists(task))
        visit(child.tasks, [...taskPath, ...child.path], depth + 1);
    });
  };
  visit(flow.tasks, ["tasks"], 1);
  visit(flow.errors, ["errors"], 1);
  visit(flow.finally, ["finally"], 1);
  if (count > flowMaximumTaskCount)
    add(["tasks"], source, "too_many_items", `A flow can hold at most ${flowMaximumTaskCount} tasks including nested tasks`);
};

// ─── Flows that call each other ────────────────────────────────────────────────────────────────

/**
 * Checks Run flow across canonical flows that can see each other: no cycles, at most three nested
 * calls, and a transaction flow calling only transaction flows. Each issue names the flow.
 */
export function validateFlowSet(flows: readonly FlowDefinition[]): FlowSetValidationIssue[] {
  return validateFlowCallGraph(flows).map((issue) => {
    const [ruleCode, family] = callCodes[issue.code];
    return { flowId: issue.flowId, path: [], ruleCode, family, message: issue.message };
  });
}

/**
 * Places an issue on the flow's location: the flow itself, and the task it names when it has one.
 * The location carries readable keys only, never customer values.
 */
export const flowIssueLocation = (
  flowLocation: DefinitionValidationLocation | undefined,
  issue: Pick<FlowValidationIssue, "taskId">,
): DefinitionValidationLocation | undefined => {
  if (flowLocation === undefined || issue.taskId === undefined || flowLocation.segments.length >= 12)
    return flowLocation;
  return {
    ...flowLocation,
    segments: [...flowLocation.segments, { kind: "flow_node", key: issue.taskId }],
  };
};
