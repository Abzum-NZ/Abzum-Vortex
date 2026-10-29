import { valueTypesCompatible, workflowValueTypeSchema } from "../catalogue/catalogues";
import { checkFlowFormula } from "../rules/flow-formula";
import { formatterCatalogue, unitCatalogue } from "../pages/value-format";
import { recordTypeIdSchema } from "../catalogue/identifiers";
import type {
  DefinitionRuleFailureFamily,
  DefinitionValidationLocation,
} from "../catalogue/validation-errors";
import {
  flowTaskChildLists,
  isFlowControlTask,
  validateFlowCallGraph,
  type FlowDefinition,
  type FlowSource,
  type FlowTask,
} from "../workflows/flow-contracts";
import type { SourceFlow } from "../workflows/flow-source-contracts";
import {
  flowTaskRegistry,
  validateFlowTaskPlacement,
  type FlowTaskPlacementIssue,
  type FlowTaskTypeDefinition,
} from "../workflows/flow-task-registry";
import {
  flowMaximumTaskOutputPathDepth,
  type FlowFormula,
  type FlowReference,
  type FlowValue,
} from "../workflows/flow-values";
import type { DefinitionCompilerRefusalCode } from "./compilation-error";
import { flowTaskOutputMembers } from "./flow-output-members";
import { flowStepSettingIssues } from "./flow-step-settings";
import {
  allTasksIn,
  checkDeclaration,
  taskIdAtPath,
  validateStructure,
  type DeclarationView,
  type Path,
} from "./flow-structure-validation";

/**
 * The one flow validator. It replaces the free-graph validators (frontend flow
 * routing, workflow reachability and the Kestra compiler's repeats) for the single
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
 *   the one value-type compatibility function (`valueTypesCompatible`, the `flow` context). Run
 *   flow and Run background flow must name a flow compiled with this one, so the target's inputs,
 *   outputs and execution kind are known. Show form's input map declares its answer names and
 *   types; a field path on its values output must select a declared member. A trigger record field
 *   (whose existence the caller checks) and a person's answer to Wait for person stay typed only
 *   at run time;
 * - outputs and error handling: an output's value must fit its declared type, and `outcome` is
 *   readable only from a task that sets `allowRefusal`.
 *
 * Nothing here requires a refused, validation, conflict or uncertain result to be routed. The
 * default error handler presents those results safely, and `errors` only adds behaviour.
 *
 * The validator reads a flow in either shape: the authored source (readable aliases) or the
 * canonical flow (permanent identities). It never resolves an alias itself, so it invents no
 * identity; the caller's `targetFlow` and `triggerRecordFieldExists` do any resolution.
 * It returns every issue with a path relative to the flow; callers place them on the definition.
 */

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
   * The authored title of a form named by a Show form step, when validating an application: an
   * empty string for a form without one, undefined when no form has that reference.
   */
  formTitle?: ((reference: string) => string | undefined) | undefined;
  /**
   * Finds a flow compiled together with this one, in either shape, from the reference a `run_flow`
   * or `backend.run` task names. A target it does not return has no declared inputs,
   * outputs or execution kind here, so the call is refused rather than left untyped.
   */
  targetFlow?: (reference: string) => FlowDefinition | FlowSource | SourceFlow | undefined;
  /**
   * Whether every record type a record trigger names has this field. `trigger.record.x` and
   * `trigger.previous.x` naming a field it rejects are refused. Without it, the field is not
   * checked; its value type belongs to the record type and is checked by the evaluator.
   */
  triggerRecordFieldExists?: (field: string) => boolean;
  /**
   * The declared inputs, with their types, of the operation a Call protected operation task names
   * by its readable key. Without it, the inputs the task maps are not checked against the
   * operation; with it, a mapped input must be one the operation declares, every required one
   * must be mapped, and each value must be of the declared type.
   */
  operationInputs?: (key: string) => ReadonlyMap<string, OperationInputDeclaration> | undefined;
}>;

/** One declared input of a callable operation. */
export type OperationInputDeclaration = Readonly<{ required: boolean; type: string }>;

/**
 * Whether a value of the given static type fills an operation input of the declared type. This is
 * the one rule for both the publication check and Studio's offer: a value whose type is not known
 * here is left to run time, and a set of values (a form's whole answer set) never fills one scalar.
 */
export const operationInputAccepts = (actual: string | undefined, expected: string): boolean =>
  actual === undefined || valueTypesCompatible(actual, expected, "operation_input");

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
  not_yet_runnable: ["vortex.definition.unsupported_workflow_node", "unsupported_choice"],
};

const callCodes = {
  cycle: ["vortex.definition.workflow_child_acyclic", "dependency_cycle"],
  depth_exceeded: ["vortex.definition.workflow_child_depth", "too_many_items"],
  transaction_calls_non_transaction: [
    "vortex.definition.workflow_child_reference",
    "invalid_value",
  ],
} as const satisfies Record<
  string,
  readonly [DefinitionCompilerRefusalCode, DefinitionRuleFailureFamily]
>;

// ─── Value types ───────────────────────────────────────────────────────────────────────────────

/** The static type of a value, or `undefined` when only the runtime evaluator can know it. */
type StaticType = string | undefined;

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
  "placement_id",
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

const isTextLiteral = (value: FlowValue | undefined): boolean =>
  value?.kind === "literal" &&
  value.literal.type === "text" &&
  typeof value.literal.value === "string";

/** The value type a Calculate step declares as its result, when it names a known one. */
const calculationResultType = (task: FlowTask): StaticType | undefined => {
  const value = (task as { properties?: Record<string, FlowValue> }).properties?.result_type;
  return value?.kind === "literal" &&
    typeof value.literal.value === "string" &&
    workflowValueTypeSchema.safeParse(value.literal.value).success
    ? (value.literal.value as StaticType)
    : undefined;
};

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

  // ── Contract 4 step settings: closed values, and settings that do not run yet. ──
  for (const issue of flowStepSettingIssues(flow))
    if (issue.notYetRunnable)
      add(
        issue.path,
        "vortex.definition.unsupported_workflow_node",
        "unsupported_choice",
        issue.message,
      );
    else add(issue.path, "vortex.definition.workflow_node_values", "invalid_value", issue.message);

  // ── Structure and limits. ──
  validateStructure(flow, add);

  // A save supplies its current and previous record, with no caller inputs or child-flow host.
  // Keep unsupported save declarations at publication, rather than skipping them at execution.
  if (flow.triggers.some((trigger) => trigger.type === "BeforeSave")) {
    const unsupported = (path: Path, message: string) =>
      add(path, "vortex.definition.unsupported_workflow_node", "unsupported_choice", message);
    if (flow.triggers.length !== 1)
      unsupported(["triggers"], "A flow before a save has exactly one record trigger");
    for (const name of ["inputs", "variables", "outputs"] as const)
      if (Object.keys(flow[name]).length > 0)
        unsupported([name], `A flow before a save cannot declare ${name}`);
    for (const name of ["errors", "finally"] as const)
      if (flow[name].length > 0)
        unsupported([name], `A flow before a save cannot declare ${name} tasks`);
    if (flow.invocationPermissionId !== undefined)
      unsupported(
        ["invocationPermissionId"],
        "The save checks permission before running its flows",
      );
    flow.triggers.forEach((trigger, index) => {
      if (Object.keys(trigger.inputs).length > 0)
        unsupported(["triggers", index, "inputs"], "A save trigger supplies only its record");
      // Not yet runnable: the one record writer applies rules to deletes and restores later.
      if (trigger.type === "BeforeSave")
        trigger.operations.forEach((operation, operationIndex) => {
          if (operation.kind === "delete" || operation.kind === "restore")
            unsupported(
              ["triggers", index, "operations", operationIndex],
              `A rule before a record is ${operation.kind === "delete" ? "deleted" : "restored"} cannot run yet; cover create or update`,
            );
        });
    });
  }

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
      // A name declared twice must keep one type, or no reference to it could be typed.
      if (into.has(name) && into.get(name) !== declaration.type)
        add(
          [...path, name, "type"],
          "vortex.definition.source_type_compatibility",
          "invalid_value",
          `The input ${name} is already declared with the type ${into.get(name)}`,
        );
      else into.set(name, declaration.type);
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
  // An interactive flow reads the record it runs for the same way a triggered flow reads its record.
  const hasRecord = hasRecordTrigger || flow.recordInput !== undefined;

  // ── Typed references. ──
  type Where = { nowAllowed: boolean; scope: ReadonlyMap<string, FlowTask>; triggerOnly: boolean };

  const findFlow = (reference: string): FlowSource | undefined =>
    options.targetFlow?.(reference) as FlowSource | undefined;

  const outputType = (task: FlowTask, key: string) => {
    if (task.type === "run_flow") {
      // An unknown target is refused on the task itself.
      const target = findFlow((task as { flowId: string }).flowId);
      if (target === undefined) return { known: true as const, type: undefined };
      const declared = Object.hasOwn(target.outputs, key) ? target.outputs[key] : undefined;
      return declared === undefined
        ? { known: false as const }
        : { known: true as const, type: declared.type as StaticType };
    }
    if (isFlowControlTask(task)) return { known: false as const };
    const registered = task as Extract<FlowTask, { properties: unknown }>;
    if (key === "outcome" && registered.allowRefusal === true)
      return { known: true as const, type: "choice" as StaticType };
    const definition: FlowTaskTypeDefinition | undefined = Object.hasOwn(
      flowTaskRegistry,
      task.type,
    )
      ? flowTaskRegistry[task.type as keyof typeof flowTaskRegistry]
      : undefined;
    // An unregistered type is already refused by the placement check.
    if (definition === undefined) return { known: true as const, type: undefined };
    if (task.type === "data.calculate" && key === "value")
      return { known: true as const, type: calculationResultType(task) };
    const declared = definition.outputs.find((output) => output.key === key);
    return declared === undefined
      ? { known: false as const }
      : { known: true as const, type: declared.type as StaticType };
  };

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
      case "module_field":
        add(
          path,
          "vortex.definition.workflow_node_references",
          "invalid_value",
          "Permanent Module field references are allowed only in Record calculations, not in flows",
        );
        return undefined;
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
        if (reference.source === "trigger_previous" ? !hasRecordTrigger : !hasRecord)
          add(
            path,
            "vortex.definition.trigger_record_required",
            "required_value",
            reference.source === "trigger_previous"
              ? "Only a flow with a BeforeSave or Event trigger has the record's values before the change"
              : "Only a flow with a BeforeSave or Event trigger, or an interactive flow that names its record input, has a record",
          );
        else if (options.triggerRecordFieldExists?.(reference.field) === false)
          add(
            path,
            "vortex.definition.workflow_node_references",
            "broken_reference",
            `The trigger record has no field ${reference.field}`,
          );
        // A record field's type belongs to the record type, which the flow does not carry.
        return undefined;
      case "execution_actor":
        return "organization_account_reference";
      case "execution_now":
        return "date_time";
      // Not yet runnable: the page runner reads page values and form fields in page segments.
      case "page":
      case "form":
        add(
          path,
          "vortex.definition.unsupported_workflow_node",
          "unsupported_choice",
          reference.source === "page"
            ? `The page value ${reference.name} cannot be read yet`
            : `The form field ${reference.form}.${reference.field} cannot be read yet`,
        );
        return undefined;
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
        const output = outputType(task, reference.key);
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
        if (reference.path !== undefined) {
          if (output.type !== "json") {
            add(
              path,
              "vortex.definition.workflow_node_values",
              "invalid_value",
              `Task ${reference.task}.${reference.key} does not declare a JSON output that can be read by field path`,
            );
            return undefined;
          }
          if (reference.path.length > flowMaximumTaskOutputPathDepth) {
            add(
              path,
              "vortex.definition.workflow_node_values",
              "too_many_items",
              `A task output field path can contain at most ${flowMaximumTaskOutputPathDepth} names`,
            );
            return undefined;
          }
          const declared = flowTaskOutputMembers(task, reference.key);
          if (declared === undefined) {
            add(
              path,
              "vortex.definition.workflow_node_references",
              "broken_reference",
              `Task ${reference.task}.${reference.key} declares no named output fields`,
            );
            return undefined;
          }
          const declaredMember = declared.members.find(
            (candidate) => candidate.name === reference.path![0],
          );
          if (declaredMember === undefined) {
            add(
              path,
              "vortex.definition.workflow_node_references",
              "broken_reference",
              `Task ${reference.task}.${reference.key} declares no field ${reference.path[0]}`,
            );
            return undefined;
          }
          if (reference.path.length !== 1) {
            add(
              path,
              "vortex.definition.workflow_node_values",
              "invalid_value",
              task.type === "interface.show_form"
                ? `Step ${reference.task} answer ${declaredMember.name} can only be read as a whole`
                : `Task ${reference.task}.${reference.key} exposes only one declared member at a time`,
            );
            return undefined;
          }
          if (task.type !== "interface.show_form") return declaredMember.type as StaticType;
          const inputs = (task as Extract<FlowTask, { properties: Record<string, FlowValue> }>)
            .properties.inputs!;
          return valueType(
            (inputs as Extract<FlowValue, { kind: "map" }>).entries[declaredMember.name]!,
            where,
            path,
          );
        }
        if (flowTaskOutputMembers(task, reference.key)?.whole === false) {
          add(
            path,
            "vortex.definition.workflow_node_values",
            "invalid_value",
            `Task ${reference.task}.${reference.key} must name one declared member`,
          );
          return undefined;
        }
        return output.type;
      }
    }
  };

  const checkFormulaAt = (formula: FlowFormula, where: Where, path: Path): StaticType =>
    checkFlowFormula(
      formula,
      {
        nowAllowed: where.nowAllowed,
        reference: (reference, referencePath) => resolveReference(reference, where, referencePath),
        issue: add,
      },
      path,
    );

  const valueType = (value: FlowValue, where: Where, path: Path): StaticType => {
    switch (value.kind) {
      case "literal":
        return value.literal.type;
      case "reference":
        return resolveReference(value.reference, where, [...path, "reference"]);
      case "formula":
        return checkFormulaAt(value.formula, where, [...path, "formula"]);
      // A map is a JSON object of values. Every entry is checked as a value of its own, so a
      // reference inside it resolves or is refused exactly as one outside it would be.
      case "map":
        for (const [key, entry] of Object.entries(value.entries))
          checkValue(entry, undefined, where, [...path, "entries", key]);
        return "json";
      case "array":
        value.items.forEach((item, index) =>
          checkValue(item, undefined, where, [...path, "items", index]),
        );
        return "json";
    }
  };

  /** Checks a value against the types its use accepts; `undefined` accepts any value. */
  const checkValue = (
    value: FlowValue,
    accepted: readonly string[] | undefined,
    where: Where,
    path: Path,
    operationInput = false,
  ) => {
    const actual = valueType(value, where, path);
    if (accepted === undefined) return;
    // A constructed map or array is never one scalar, so it fills only a use that accepts JSON;
    // its static `json` type would otherwise pass every typed use and fail only at run time.
    if (value.kind === "map" || value.kind === "array") {
      if (!accepted.includes("json"))
        add(
          path,
          "vortex.definition.source_type_compatibility",
          "invalid_value",
          `Expected ${describe(accepted)}, found a ${value.kind} of values`,
        );
      return;
    }
    if (actual === undefined) return;
    if (operationInput) {
      if (accepted.some((expected) => operationInputAccepts(actual, expected))) return;
      add(
        path,
        "vortex.definition.source_type_compatibility",
        "invalid_value",
        `Expected ${describe(accepted)}, found ${actual === "json" ? "a set of values" : actual}`,
      );
      return;
    }
    const literal = value.kind === "literal";
    if (
      literal
        ? accepted.some((expected) => valueTypesCompatible(actual, expected, "value"))
        : fits(actual, accepted)
    )
      return;
    add(
      path,
      "vortex.definition.source_type_compatibility",
      "invalid_value",
      `Expected ${describe(accepted)}, found ${actual}`,
    );
  };

  const refuseUnknownTarget = (path: Path) =>
    add(
      path,
      "vortex.definition.workflow_child_reference",
      "broken_reference",
      "The flow to run must be compiled with this flow, so its inputs, outputs and execution kind are known",
    );

  const checkInputMap = (
    values: Readonly<Record<string, FlowValue>>,
    target: FlowSource | undefined,
    where: Where,
    path: Path,
  ) => {
    for (const [name, value] of Object.entries(values)) {
      const declared =
        target !== undefined && Object.hasOwn(target.inputs, name)
          ? target.inputs[name]
          : undefined;
      if (target !== undefined && declared === undefined)
        add(
          [...path, name],
          "vortex.definition.workflow_node_values",
          "unknown_property",
          `The target flow declares no input named ${name}`,
        );
      checkValue(value, declared === undefined ? undefined : [declared.type], where, [
        ...path,
        name,
      ]);
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

  /** Checks the inputs a Call protected operation task maps against the operation's declared inputs. */
  const checkOperationInputs = (
    operation: ReadonlyMap<string, OperationInputDeclaration>,
    mapped: Extract<FlowValue, { kind: "map" }>,
    where: Where,
    path: Path,
  ) => {
    for (const [name, entry] of Object.entries(mapped.entries)) {
      const declared = operation.get(name);
      const entryPath = [...path, "entries", name];
      if (declared === undefined) {
        valueType(entry, where, entryPath);
        add(
          entryPath,
          "vortex.definition.workflow_action_inputs",
          "unknown_property",
          `The operation declares no input named ${name}`,
        );
      } else checkValue(entry, [declared.type], where, entryPath, true);
    }
    for (const [name, declared] of operation)
      if (declared.required && !Object.hasOwn(mapped.entries, name))
        add(
          path,
          "vortex.definition.workflow_action_inputs",
          "required_value",
          `The operation requires the input ${name}`,
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
    if (task.type === "data.format" && name === "formatter" && isTextLiteral(value)) {
      const formatter = (value as Extract<FlowValue, { kind: "literal" }>).literal.value;
      const rejectFormat = (property: string, message: string) =>
        add(
          [...path.slice(0, -1), property],
          "vortex.definition.workflow_node_values",
          "invalid_value",
          message,
        );
      if (typeof formatter !== "string" || !formatterCatalogue.some((entry) => entry === formatter))
        rejectFormat("formatter", "Choose a registered formatter");
      const currency = task.properties.currency;
      const unit = task.properties.unit;
      const input = task.properties.input;
      const inputType =
        input === undefined ? undefined : valueType(input, where, [...path.slice(0, -1), "input"]);
      if (formatter === "money" && inputType !== "money" && currency === undefined)
        rejectFormat("currency", "Money formatting needs a currency unless its input carries one");
      if (
        currency !== undefined &&
        (!isTextLiteral(currency) ||
          !/^[A-Z]{3}$/.test(
            String((currency as Extract<FlowValue, { kind: "literal" }>).literal.value),
          ))
      )
        rejectFormat("currency", "Use a literal uppercase three-letter currency code");
      if (
        formatter === "unit" &&
        (!isTextLiteral(unit) ||
          !Object.hasOwn(
            unitCatalogue,
            String((unit as Extract<FlowValue, { kind: "literal" }>).literal.value),
          ))
      )
        rejectFormat("unit", "Choose a registered unit");
      const places = task.properties.places;
      if (
        places?.kind === "literal" &&
        (typeof places.literal.value !== "number" ||
          !Number.isInteger(places.literal.value) ||
          places.literal.value < 0 ||
          places.literal.value > 18)
      )
        rejectFormat("places", "Decimal places must be a whole number from 0 to 18");
    }
    if (
      task.type === "interface.show_form" &&
      name === "form" &&
      value.kind === "literal" &&
      value.literal.type === "text" &&
      typeof value.literal.value === "string" &&
      options.formTitle?.(value.literal.value)?.trim() === ""
    )
      add(
        path,
        "vortex.definition.workflow_node_values",
        "required_value",
        `Show form step ${task.description ?? definition.title} names form ${value.literal.value}, which has no title. Give the form a title.`,
      );
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
        add(
          path,
          "vortex.definition.workflow_node_values",
          "invalid_value",
          `${name} must be a formula`,
        );
      else {
        const type = checkFormulaAt(value.formula, where, [...path, "formula"]);
        // A calculation declares its result type, and its formula must produce it.
        const declaredResult = calculationResultType(task);
        if (
          task.type === "data.calculate" &&
          type !== undefined &&
          declaredResult !== undefined &&
          !valueTypesCompatible(type, declaredResult, "flow")
        )
          add(
            path,
            "vortex.definition.workflow_node_values",
            "invalid_value",
            `This calculation produces ${type}, not its declared result type ${declaredResult}`,
          );
      }
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
      else if (declared.type === "flow_id") {
        const target = findFlow(String((value as { literal: { value: unknown } }).literal.value));
        if (target === undefined) refuseUnknownTarget(path);
        else if (task.type === "backend.run" && target.execution !== "background")
          add(
            path,
            "vortex.definition.workflow_child_reference",
            "invalid_value",
            "Run on back end runs only a back-end (background) flow",
          );
      }
      return;
    }
    if (declared.type === "input_map" && value.kind === "array") {
      valueType(value, where, path);
      add(
        path,
        "vortex.definition.workflow_node_values",
        "invalid_value",
        `${name} needs named inputs, never an array of values`,
      );
      return;
    }
    if (task.type === "operation.call" && name === "inputs" && value.kind === "map") {
      const operationKey = task.properties.operation;
      const operation =
        options.operationInputs !== undefined && isTextLiteral(operationKey)
          ? options.operationInputs(
              String((operationKey as { literal: { value: unknown } }).literal.value),
            )
          : undefined;
      if (operation !== undefined) {
        checkOperationInputs(operation, value, where, path);
        return;
      }
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
  };

  const checkRecordLinkTask = (task: Extract<FlowTask, { properties: unknown }>, path: Path) => {
    const properties = task.properties as Readonly<Record<string, FlowValue>>;
    const recordType = properties.record_type;
    let targetTypeId: string | undefined;
    if (!isTextLiteral(recordType)) {
      add(
        [...path, "properties", "record_type"],
        "vortex.definition.workflow_node_values",
        "invalid_value",
        "Build record link value requires one literal record type identity",
      );
    } else {
      targetTypeId = String((recordType as { literal: { value: unknown } }).literal.value);
      const canonicalFlow = Object.hasOwn(flow, "namespace");
      if (canonicalFlow && !recordTypeIdSchema.safeParse(targetTypeId).success) {
        add(
          [...path, "properties", "record_type"],
          "vortex.definition.workflow_node_values",
          "invalid_value",
          "The compiled record type must be a valid canonical identity",
        );
        targetTypeId = undefined;
      } else if (!canonicalFlow && recordTypeIdSchema.safeParse(targetTypeId).success) {
        add(
          [...path, "properties", "record_type"],
          "vortex.definition.workflow_node_values",
          "invalid_value",
          "A source record type must be a readable alias, not a canonical identity",
        );
        targetTypeId = undefined;
      }
    }

    const record = properties.record;
    if (record?.kind !== "reference" || record.reference.source !== "input") {
      add(
        [...path, "properties", "record"],
        "vortex.definition.workflow_node_references",
        "invalid_value",
        "Build record link value must reference one declared record input directly",
      );
      return;
    }

    const declaration = flow.inputs[record.reference.name];
    if (
      declaration === undefined ||
      declaration.type !== "record_reference" ||
      declaration.recordTypeIds?.length !== 1
    ) {
      add(
        [...path, "properties", "record"],
        "vortex.definition.workflow_node_references",
        "invalid_value",
        "The record input must declare exactly one record_reference type",
      );
      return;
    }
    if (targetTypeId !== undefined && targetTypeId !== declaration.recordTypeIds[0])
      add(
        [...path, "properties", "record"],
        "vortex.definition.workflow_node_values",
        "invalid_value",
        "The declared record input must target the task's record type identity",
      );
  };

  const checkTask = (task: FlowTask, path: Path, scope: Scope) => {
    const where: Where = { nowAllowed: timeAllowed, scope, triggerOnly: false };
    switch (task.type) {
      case "if": {
        const node = task as Extract<FlowTask, { type: "if" }>;
        const type = checkFormulaAt(node.condition, where, [...path, "condition"]);
        if (type !== undefined && type !== "json" && type !== "yes_no")
          add(
            [...path, "condition"],
            "vortex.definition.source_type_compatibility",
            "invalid_value",
            `A condition must be a yes/no value, found ${type}`,
          );
        return;
      }
      case "switch": {
        const node = task as Extract<FlowTask, { type: "switch" }>;
        const type = valueType(node.value, where, [...path, "value"]);
        if (node.value.kind === "map" || node.value.kind === "array")
          add(
            [...path, "value"],
            "vortex.definition.source_type_compatibility",
            "invalid_value",
            `A switch compares one value, never a ${node.value.kind} of values`,
          );
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
        if (node.items.kind === "map")
          add(
            [...path, "items"],
            "vortex.definition.source_type_compatibility",
            "invalid_value",
            "For each needs a list, found a map of values",
          );
        else if (type !== undefined && type !== "json" && !listTypes.has(type))
          add(
            [...path, "items"],
            "vortex.definition.source_type_compatibility",
            "invalid_value",
            `For each needs a list, found ${type}`,
          );
        return;
      }
      case "run_flow": {
        const node = task as Extract<FlowTask, { type: "run_flow" }>;
        const target = findFlow(node.flowId as string);
        if (target === undefined) refuseUnknownTarget([...path, "flowId"]);
        checkInputMap(node.inputs, target, where, [...path, "inputs"]);
        return;
      }
      case "sequential":
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
        if (node.type === "data.record_link") checkRecordLinkTask(node, path);
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
        walk(
          child.tasks,
          [...taskPath, ...child.path],
          task.type === "sequential" ? scope : new Map(scope),
        );
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
    const type = checkFormulaAt(
      trigger.condition,
      { nowAllowed: false, scope: new Map(), triggerOnly: true },
      ["triggers", index, "condition"],
    );
    if (type !== undefined && type !== "json" && type !== "yes_no")
      add(
        ["triggers", index, "condition"],
        "vortex.definition.source_type_compatibility",
        "invalid_value",
        `A condition must be a yes/no value, found ${type}`,
      );
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
  if (
    flowLocation === undefined ||
    issue.taskId === undefined ||
    flowLocation.segments.length >= 12
  )
    return flowLocation;
  return {
    ...flowLocation,
    segments: [...flowLocation.segments, { kind: "flow_node", key: issue.taskId }],
  };
};
