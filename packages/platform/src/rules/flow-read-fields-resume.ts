import type { JsonValue } from "../catalogue/common";
import {
  flowReadFieldsProjectionSchema,
  flowReadFieldsTypeMapSchema,
  flowTaskChildLists,
  type FlowTask,
} from "../workflows/flow-contracts";
import type { FlowValue } from "../workflows/flow-values";
import { typedValueMatchesType } from "./condition-types";

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

export const validReadFieldsResume = (
  task: FlowTask | undefined,
  produced: Readonly<Record<string, JsonValue>> | undefined,
): boolean => {
  if (task?.type !== "record.read_fields") return false;
  const registered = task as Extract<FlowTask, { properties: unknown }> & {
    properties: Readonly<Record<string, FlowValue>>;
    readFieldTypes?: Readonly<Record<string, string>>;
  };
  const fields = registered.properties.fields;
  const projection =
    fields?.kind === "literal" && fields.literal.type === "json"
      ? flowReadFieldsProjectionSchema.safeParse(fields.literal.value)
      : undefined;
  const types = flowReadFieldsTypeMapSchema.safeParse(registered.readFieldTypes);
  if (!projection?.success || !types.success) return false;
  const declaredAliases = projection.data.map((field) => field.alias);
  const typeAliases = Object.keys(types.data);
  if (
    declaredAliases.length !== typeAliases.length ||
    declaredAliases.some((alias) => !Object.hasOwn(types.data, alias))
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
      (alias) =>
        Object.hasOwn(actual, alias) &&
        typedValueMatchesType(actual[alias], types.data[alias]!, "flow"),
    )
  );
};
