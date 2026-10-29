import type { DefinitionRuleFailureFamily } from "../catalogue/validation-errors";
import { flowTaskChildLists, flowTriggerExecutionKinds, type FlowSource, type FlowTask } from "../workflows/flow-contracts";
import { flowLiteralSchema } from "../workflows/flow-values";
import type { DefinitionCompilerRefusalCode } from "./compilation-error";
import { flowMaximumForEachItemsDurable, flowMaximumForEachItemsOther, flowMaximumServerSeconds, flowMaximumTaskCount, flowMaximumTaskNestingDepth } from "../workflows/flow-limits";

/** A location inside a flow source: object keys and array indexes from its root. */
export type Path = (string | number)[];

/**
 * The structural half of the one flow validator (`flow-validation.ts`): task identity, count and
 * nesting, triggers against the execution kind, policies and typed declarations.
 */

export const allTasksIn = (tasks: readonly FlowTask[]): Map<string, FlowTask> => {
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

export const taskIdAtPath = (flow: unknown, path: Path): string | undefined => {
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

export type DeclarationView = Readonly<{
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

export const checkDeclaration = (declaration: DeclarationView, path: Path, add: Add) => {
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

export const validateStructure = (flow: FlowSource, add: Add) => {
  const durable = flow.execution === "durable";
  const source = "vortex.definition.source_shape" as const;

  for (const name of Object.keys(flow.variables))
    if (Object.hasOwn(flow.inputs, name))
      add(
        ["variables", name],
        source,
        "duplicate_key",
        "A variable cannot reuse the name of an input",
      );

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

  // Only an interactive flow names the input that carries its record: one required record input.
  if (flow.recordInput !== undefined) {
    const declaration = Object.hasOwn(flow.inputs, flow.recordInput)
      ? flow.inputs[flow.recordInput]
      : undefined;
    if (flow.execution !== "interactive")
      add(
        ["recordInput"],
        "vortex.definition.workflow_node_values",
        "invalid_value",
        "Only an interactive flow names the input that carries its record; a record trigger supplies it otherwise",
      );
    else if (
      declaration === undefined ||
      declaration.type !== "record_reference" ||
      !declaration.required ||
      declaration.recordTypeIds?.length !== 1
    )
      add(
        ["recordInput"],
        "vortex.definition.workflow_node_references",
        "broken_reference",
        "The record input must be a declared, required input naming one record of one record type",
      );
  }

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
    add(
      ["timeout", "seconds"],
      source,
      "invalid_value",
      `Only durable flows may time out after more than ${flowMaximumServerSeconds} seconds`,
    );
  if (
    flow.concurrency !== undefined &&
    flow.execution !== "durable" &&
    flow.execution !== "background"
  )
    add(
      ["concurrency"],
      source,
      "invalid_value",
      "Concurrency limits apply only to background and durable flows",
    );

  // Tasks: identity, count, nesting and per-task limits.
  const seen = new Set<string>();
  let count = 0;
  const forEachMaximum = durable ? flowMaximumForEachItemsDurable : flowMaximumForEachItemsOther;
  const visit = (tasks: readonly FlowTask[], path: Path, depth: number) => {
    tasks.forEach((task, index) => {
      const taskPath = [...path, index];
      count += 1;
      if (depth > flowMaximumTaskNestingDepth)
        add(
          taskPath,
          source,
          "too_many_items",
          `Tasks cannot nest deeper than ${flowMaximumTaskNestingDepth} levels`,
        );
      if (seen.has(task.id))
        add([...taskPath, "id"], source, "duplicate_key", "Task ids must be unique in a flow");
      seen.add(task.id);
      if (!durable && task.retry !== undefined)
        add(
          [...taskPath, "retry"],
          source,
          "invalid_value",
          "Retries are allowed only in durable flows",
        );
      if (!durable && task.timeout !== undefined && task.timeout.seconds > flowMaximumServerSeconds)
        add(
          [...taskPath, "timeout", "seconds"],
          source,
          "invalid_value",
          `Only durable flows may time out after more than ${flowMaximumServerSeconds} seconds`,
        );
      if (
        task.type === "for_each" &&
        (task as { maximumItems: number }).maximumItems > forEachMaximum
      )
        add(
          [...taskPath, "maximumItems"],
          source,
          "too_many_items",
          `For each allows at most ${forEachMaximum.toLocaleString("en-NZ")} items in ${durable ? "durable" : "non-durable"} flows`,
        );
      for (const child of flowTaskChildLists(task))
        visit(child.tasks, [...taskPath, ...child.path], depth + 1);
    });
  };
  visit(flow.tasks, ["tasks"], 1);
  visit(flow.errors, ["errors"], 1);
  visit(flow.finally, ["finally"], 1);
  if (count > flowMaximumTaskCount)
    add(
      ["tasks"],
      source,
      "too_many_items",
      `A flow can hold at most ${flowMaximumTaskCount} tasks including nested tasks`,
    );
};
