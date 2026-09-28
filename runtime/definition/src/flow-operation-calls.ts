import {
  PLATFORM_SERVICE_OPERATIONS,
  flowTaskChildLists,
  platformOperationKey,
  canonicalizeProtectedOperationReferences,
  type DefinitionRuleFailureFamily,
  type FlowDefinition,
  type FlowTask,
  type PlatformServiceOperationCatalogueEntry,
  type ProtectedOperationReference,
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

export type ProtectedOperationReferenceLookups = Readonly<{
  recordTypesById: ReadonlyMap<string, ProtectedOperationReference>;
  queriesById: ReadonlyMap<string, ProtectedOperationReference>;
  relationshipRecordTypeIdsById: ReadonlyMap<string, readonly string[]>;
}>;

export type FlowNodeOperationReferences = Readonly<{
  flowId: FlowDefinition["id"];
  nodeId: FlowTask["id"];
  taskType: string;
  operations: readonly ProtectedOperationReference[];
}>;

export type FlowOperationNodeDescriptor = Readonly<{
  flowId: FlowDefinition["id"];
  nodeId: FlowTask["id"];
  taskType: string;
  operationId?: string;
  recordTypeIds: readonly string[];
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

const flowTasks = (tasks: readonly FlowTask[]): FlowTask[] =>
  tasks.flatMap((task) => [
    task,
    ...flowTaskChildLists(task).flatMap((child) => flowTasks(child.tasks)),
  ]);

/** Lists the protected Record and Query node identities in one published flow set. */
export function flowOperationNodeDescriptors(
  flows: readonly FlowDefinition[],
): FlowOperationNodeDescriptor[] {
  const nodes = flows.flatMap((flow) =>
    [...flowTasks(flow.tasks), ...flowTasks(flow.errors), ...flowTasks(flow.finally)]
      .filter((task) => task.type === "record.query" || task.type.startsWith("record."))
      .map((task) => {
        const properties = (task as Extract<FlowTask, { properties: unknown }>).properties;
        const operationId = task.type === "record.query" ? literalIdentity(properties.query) : undefined;
        const recordTypeIds =
          task.type === "record.query" || task.type === "record.link"
            ? []
            : [
                literalIdentity(properties.record_type),
                ...declaredRecordTypeIds(flow, properties.record),
                ...declaredChangeListRecordTypeIds(flow, properties.changes),
              ]
                .filter((recordTypeId): recordTypeId is string => recordTypeId !== undefined)
                .map((recordTypeId) => recordTypeId.toLowerCase())
                .filter((recordTypeId, index, ids) => ids.indexOf(recordTypeId) === index)
                .sort();
        return {
          flowId: flow.id,
          nodeId: task.id,
          taskType: task.type,
          ...(operationId === undefined ? {} : { operationId }),
          recordTypeIds,
        };
      }),
  );
  const nodeIdentities = nodes.map(
    (node) => `${String(node.flowId).toLowerCase()}:${node.nodeId.toLowerCase()}`,
  );
  if (new Set(nodeIdentities).size !== nodeIdentities.length)
    throw new Error("Published Record and Query node identities must be unique within each flow");
  return nodes.sort((left, right) => {
    const leftFlowId = String(left.flowId).toLowerCase();
    const rightFlowId = String(right.flowId).toLowerCase();
    if (leftFlowId !== rightFlowId) return leftFlowId < rightFlowId ? -1 : 1;
    const leftNodeId = left.nodeId.toLowerCase();
    const rightNodeId = right.nodeId.toLowerCase();
    return leftNodeId < rightNodeId ? -1 : leftNodeId > rightNodeId ? 1 : 0;
  });
}

const literalIdentity = (value: unknown): string | undefined => {
  if (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "literal" &&
    "literal" in value &&
    typeof value.literal === "object" &&
    value.literal !== null &&
    "type" in value.literal &&
    value.literal.type === "text" &&
    "value" in value.literal &&
    typeof value.literal.value === "string"
  )
    return value.literal.value;
  return undefined;
};

const declaredRecordTypeIds = (flow: FlowDefinition, value: unknown): readonly string[] => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    value.kind !== "reference" ||
    !("reference" in value) ||
    typeof value.reference !== "object" ||
    value.reference === null ||
    !("source" in value.reference) ||
    !("name" in value.reference) ||
    typeof value.reference.name !== "string"
  )
    return [];
  if (value.reference.source === "input")
    return flow.inputs[value.reference.name]?.recordTypeIds ?? [];
  if (value.reference.source === "variable")
    return flow.variables[value.reference.name]?.recordTypeIds ?? [];
  return [];
};

/** A compiled change list may carry record-reference inputs for each subject and target. */
const declaredChangeListRecordTypeIds = (
  flow: FlowDefinition,
  value: unknown,
): readonly string[] => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    value.kind !== "literal" ||
    !("literal" in value) ||
    typeof value.literal !== "object" ||
    value.literal === null ||
    !("type" in value.literal) ||
    value.literal.type !== "json" ||
    !("value" in value.literal) ||
    !Array.isArray(value.literal.value)
  )
    return [];
  const recordTypeIds: string[] = [];
  for (const change of value.literal.value) {
    if (
      typeof change !== "object" ||
      change === null ||
      Array.isArray(change) ||
      !("kind" in change) ||
      change.kind !== "copy_relationships" ||
      !("subject" in change) ||
      !("target" in change)
    )
      return [];
    const subjectIds = declaredRecordTypeIds(flow, change.subject);
    const targetIds = declaredRecordTypeIds(flow, change.target);
    if (subjectIds.length === 0 || targetIds.length === 0) return [];
    recordTypeIds.push(...subjectIds, ...targetIds);
  }
  return recordTypeIds;
};

/** Derives the exact static Record and Query reference set for every protected flow node. */
export function flowOperationReferencesByNode(
  flows: readonly FlowDefinition[],
  lookups: ProtectedOperationReferenceLookups,
): FlowNodeOperationReferences[] {
  const nodes: FlowNodeOperationReferences[] = [];
  const seenNodeIdentities = new Set<string>();

  const recordReferenceFor = (
    recordTypeId: string,
  ): ProtectedOperationReference => {
    const reference = lookups.recordTypesById.get(recordTypeId.toLowerCase());
    if (reference === undefined)
      throw new Error("A published record type has no resolved operation owner");
    return reference;
  };

  for (const flow of flows) {
    for (const task of [
      ...flowTasks(flow.tasks),
      ...flowTasks(flow.errors),
      ...flowTasks(flow.finally),
    ]) {
      if (task.type !== "record.query" && !task.type.startsWith("record.")) continue;
      const properties = (task as Extract<FlowTask, { properties: unknown }>).properties;
      const nodeId = task.id;
      const identity = `${String(flow.id).toLowerCase()}:${nodeId.toLowerCase()}`;
      if (seenNodeIdentities.has(identity))
        throw new Error("Published Record and Query node identities must be unique within each flow");
      seenNodeIdentities.add(identity);

      if (task.type === "record.query") {
        const queryId = literalIdentity(properties.query);
        const reference =
          queryId === undefined ? undefined : lookups.queriesById.get(queryId.toLowerCase());
        if (reference === undefined)
          throw new Error("A published Query node has no resolved operation owner");
        nodes.push({
          flowId: flow.id,
          nodeId,
          taskType: task.type,
          operations: canonicalizeProtectedOperationReferences([reference]),
        });
        continue;
      }

      const recordTypeIds: string[] = [];
      if (task.type === "record.link") {
        const relationshipId = literalIdentity(properties.relationship);
        const relatedIds =
          relationshipId === undefined
            ? undefined
            : lookups.relationshipRecordTypeIdsById.get(relationshipId.toLowerCase());
        if (relatedIds === undefined || relatedIds.length < 2)
          throw new Error("A published record link has no resolved relationship bounds");
        recordTypeIds.push(...relatedIds);
      } else {
        const recordTypeId = literalIdentity(properties.record_type);
        if (recordTypeId !== undefined) recordTypeIds.push(recordTypeId);
        recordTypeIds.push(
          ...declaredRecordTypeIds(flow, properties.record),
          ...declaredChangeListRecordTypeIds(flow, properties.changes),
        );
      }

      nodes.push({
        flowId: flow.id,
        nodeId,
        taskType: task.type,
        operations: canonicalizeProtectedOperationReferences(
          [...new Set(recordTypeIds.map((recordTypeId) => recordTypeId.toLowerCase()))].map(
            (recordTypeId) => recordReferenceFor(recordTypeId),
          ),
        ),
      });
    }
  }

  return nodes.sort((left, right) => {
    const leftFlowId = String(left.flowId).toLowerCase();
    const rightFlowId = String(right.flowId).toLowerCase();
    if (leftFlowId !== rightFlowId) return leftFlowId < rightFlowId ? -1 : 1;
    const leftNodeId = left.nodeId.toLowerCase();
    const rightNodeId = right.nodeId.toLowerCase();
    return leftNodeId < rightNodeId ? -1 : leftNodeId > rightNodeId ? 1 : 0;
  });
}

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
