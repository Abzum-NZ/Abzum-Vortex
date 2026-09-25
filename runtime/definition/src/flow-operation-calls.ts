import {
  PLATFORM_SERVICE_OPERATIONS,
  flowTaskChildLists,
  platformOperationKey,
  type DefinitionRuleFailureFamily,
  type FlowDefinition,
  type FlowTask,
  type PlatformServiceOperationCatalogueEntry,
  type SourceFlow,
} from "@vortex/contracts";
import type { DefinitionCompilerRefusalCode } from "./compilation-error";

/**
 * Checks every Call protected operation task of a set of compiled flows against the operations
 * that exist. The task names its operation by a readable key and never by an identity, so this is
 * where the key is proved to name something a flow may call: a registered platform-service
 * operation or a named action of a definition the flows may reach. It fails closed on an unknown
 * key, so no call can be published that nothing could serve.
 *
 * When a task supplies no `inputs`, it passes the flow's own inputs to the operation by name, so
 * the flow's declarations are the typed input map and must match the operation's own: every input
 * the flow declares is one the operation takes, and every input the operation requires is one the
 * flow declares.
 */

/** The operation's inputs by name, each with whether it is required. */
export type CallableOperationInputs = ReadonlyMap<string, boolean>;

/** Finds the operation a key names, or nothing when it names none. */
export type CallableOperationLookup = (key: string) => CallableOperationInputs | undefined;

export type OperationCallIssue = Readonly<{
  flowKey: string;
  taskId: string;
  ruleCode: DefinitionCompilerRefusalCode;
  family: DefinitionRuleFailureFamily;
}>;

const platformOperations: ReadonlyMap<string, CallableOperationInputs> = new Map(
  Object.values(PLATFORM_SERVICE_OPERATIONS).map((operation) => [
    platformOperationKey(operation.key),
    new Map(
      Object.entries(operation.descriptor.inputs).map(([name, declaration]) => [
        name,
        declaration.required,
      ]),
    ),
  ]),
);

/** The registered platform-service operations a flow may call. */
export const platformOperationLookup: CallableOperationLookup = (key) => platformOperations.get(key);

/** A named action's callable inputs, from an action's key and its declared inputs. */
export const namedActionInputs = (
  inputs: readonly Readonly<{ key: string; required: boolean }>[],
): CallableOperationInputs => new Map(inputs.map((input) => [input.key, input.required]));

const operationKeyOf = (task: FlowTask): string | undefined => {
  const value = (task as Extract<FlowTask, { properties: unknown }>).properties?.operation;
  return value?.kind === "literal" && typeof value.literal.value === "string"
    ? value.literal.value
    : undefined;
};

const calls = (tasks: readonly FlowTask[]): FlowTask[] =>
  tasks.flatMap((task) => [
    ...(task.type === "operation.call" ? [task] : []),
    ...flowTaskChildLists(task).flatMap((child) => calls(child.tasks)),
  ]);

export function findOperationCallIssue(
  flows: readonly FlowDefinition[],
  lookup: CallableOperationLookup,
): OperationCallIssue | undefined {
  for (const flow of flows)
    for (const task of [...calls(flow.tasks), ...calls(flow.errors), ...calls(flow.finally)]) {
      const key = operationKeyOf(task);
      const operation = key === undefined ? undefined : lookup(key);
      const issue = (
        ruleCode: DefinitionCompilerRefusalCode,
        family: DefinitionRuleFailureFamily,
      ): OperationCallIssue => ({ flowKey: flow.key, taskId: task.id, ruleCode, family });
      if (operation === undefined)
        return issue("vortex.definition.workflow_node_references", "broken_reference");
      const properties = (task as Extract<FlowTask, { properties: unknown }>).properties;
      if (properties.inputs !== undefined) continue;
      if (Object.keys(flow.inputs).some((name) => !operation.has(name)))
        return issue("vortex.definition.workflow_action_inputs", "unknown_property");
      for (const [name, required] of operation)
        if (required && !Object.hasOwn(flow.inputs, name))
          return issue("vortex.definition.workflow_action_inputs", "required_value");
    }
  return undefined;
}

/**
 * The registered platform-service operations a set of flows calls, each once, in the order first
 * called. Publication pins the exact release of each in the dependency manifest, because a flow
 * names the operation only by its key.
 */
export function platformOperationsCalledBy(
  flows: readonly (FlowDefinition | SourceFlow)[],
): PlatformServiceOperationCatalogueEntry[] {
  const byKey = new Map(
    Object.values(PLATFORM_SERVICE_OPERATIONS).map((entry) => [platformOperationKey(entry.key), entry]),
  );
  const called = new Map<string, PlatformServiceOperationCatalogueEntry>();
  for (const flow of flows)
    for (const task of [
      ...calls(flow.tasks as unknown as FlowTask[]),
      ...calls(flow.errors as unknown as FlowTask[]),
      ...calls(flow.finally as unknown as FlowTask[]),
    ]) {
      const key = operationKeyOf(task);
      const entry = key === undefined ? undefined : byKey.get(key);
      if (entry !== undefined) called.set(entry.key, entry);
    }
  return [...called.values()];
}
