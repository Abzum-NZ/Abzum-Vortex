import type { JsonValue } from "../catalogue/common";
import type { FlowTask } from "../workflows/flow-contracts";
import { isFlowReadFieldsProjection, isFlowReadFieldsTypeMap } from "../workflows/flow-read-fields";
import { flowTaskChildLists } from "../workflows/flow-task-tree";
import type { FlowValue } from "../workflows/flow-values";
import type { FlowProgram } from "./flow-interpreter-types";
import { flowValueMatchesType } from "./flow-value-shapes";

export const findTask = (tasks: readonly FlowTask[], taskId: string): FlowTask | undefined => {
  for (const task of tasks) {
    if (task.id === taskId) return task;
    for (const child of flowTaskChildLists(task)) {
      const found = findTask(child.tasks, taskId);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

/** Whether a Read record fields result is exactly the projection its task declared. */
export const validReadFieldsResume = (
  flow: FlowProgram | undefined,
  taskId: string,
  produced: Readonly<Record<string, JsonValue>> | undefined,
): boolean => {
  const task =
    flow === undefined
      ? undefined
      : findTask([...flow.tasks, ...flow.errors, ...flow.finally], taskId);
  if (task?.type !== "record.read_fields") return false;
  const registered = task as Extract<FlowTask, { properties: unknown }> & {
    properties: Readonly<Record<string, FlowValue>>;
    readFieldTypes?: Readonly<Record<string, string>>;
  };
  const fields = registered.properties.fields;
  const projection =
    fields?.kind === "literal" && fields.literal.type === "json" ? fields.literal.value : undefined;
  const types = registered.readFieldTypes;
  if (!isFlowReadFieldsProjection(projection) || !isFlowReadFieldsTypeMap(types)) return false;
  const declaredAliases = projection.map((field) => field.alias);
  const typeAliases = Object.keys(types);
  if (
    declaredAliases.length !== typeAliases.length ||
    declaredAliases.some((alias) => !Object.hasOwn(types, alias))
  )
    return false;
  if (
    produced === undefined ||
    typeof produced !== "object" ||
    Array.isArray(produced) ||
    Object.keys(produced).length !== 1 ||
    !Object.hasOwn(produced, "values")
  )
    return false;
  const values: unknown = produced.values;
  if (values === null || typeof values !== "object" || Array.isArray(values)) return false;
  const actual = values as Record<string, unknown>;
  const actualAliases = Object.keys(actual);
  return (
    actualAliases.length === declaredAliases.length &&
    declaredAliases.every(
      (alias) => Object.hasOwn(actual, alias) && flowValueMatchesType(actual[alias], types[alias]!),
    )
  );
};
