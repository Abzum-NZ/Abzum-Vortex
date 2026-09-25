import "server-only";

import {
  applicationRootIdSchema,
  organizationIdSchema,
  revisionSchema,
  stableDefinitionReleaseVersionSchema,
  workflowDefinitionSchema,
  workflowNodeTypeKeys,
  type ApplicationRootId,
  type BuilderKey,
  type OrganizationId,
  type ProtectedOperationRequest,
  type SemanticVersion,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowTrigger,
} from "@vortex/contracts";

/**
 * The permanent environment a candidate flow is scoped to. The generated
 * namespace starts with this value, so a candidate from one environment can
 * never collide with or be selected as a candidate from another.
 */
export const kestraFlowCompilerEnvironments = ["local", "testing", "production"] as const;

export type KestraFlowCompilerEnvironment = (typeof kestraFlowCompilerEnvironments)[number];

/**
 * The exact identities one published workflow candidate is generated from.
 * An installation is identified by its organisation and application root;
 * `installationRevision` is that installation's Application release revision
 * and `applicationVersion` its stable published version. `workflowRevision` is
 * the exact published workflow revision. Every value is permanent Vortex
 * identity, never a mutable label or provider key.
 */
export type KestraFlowIdentity = Readonly<{
  environment: KestraFlowCompilerEnvironment;
  organizationId: OrganizationId;
  applicationRootId: ApplicationRootId;
  applicationVersion: SemanticVersion;
  installationRevision: number;
  workflowRevision: number;
}>;

/** Exactly one published definition plus the identity it is installed under. */
export type KestraFlowCompilerInput = Readonly<{
  definition: WorkflowDefinition;
  identity: KestraFlowIdentity;
}>;

/** The protected-operation envelope version every compiled callback task sends. */
export const kestraProtectedOperationContractVersion = "1.0.0";

/**
 * The signed protected-operation envelope fields fixed at compile time. They
 * come only from the validated identity and the published node, so a callback
 * can never name another organisation, application, revision or node.
 */
export type KestraProtectedOperationBinding = Readonly<
  Pick<
    ProtectedOperationRequest,
    | "contractVersion"
    | "organizationId"
    | "applicationRootId"
    | "workflowRevision"
    | "nodeId"
    | "operationKey"
  >
>;

/**
 * The envelope fields Vortex binds and signs per execution attempt. The
 * compiler never supplies them: no run, attempt, input, time, duplicate key or
 * caller proof exists at compile time.
 */
export const kestraProtectedOperationRuntimeFields = [
  "runId",
  "attempt",
  "inputs",
  "issuedAt",
  "expiresAt",
  "duplicateProtectionKey",
  "signedCallerProof",
] as const satisfies readonly Exclude<
  keyof ProtectedOperationRequest,
  keyof KestraProtectedOperationBinding
>[];

/**
 * One generic Kestra callback task. Every published node compiles to the same
 * callback shape: it calls the protected-operation endpoint with the signed
 * envelope bound in `operation`. The exact published node is retained for the
 * later per-node provider mapping; no per-application behaviour lives here.
 * `dependsOn` is the sorted set of forward predecessor task ids, so the task
 * graph sequences exactly as the published edges require; bounded-loop
 * back-edges are routing, never dependencies.
 */
export type KestraFlowTask = Readonly<{
  id: string;
  kind: "protected_operation_callback";
  operation: KestraProtectedOperationBinding;
  node: WorkflowNode;
  dependsOn: readonly string[];
}>;

/**
 * One published edge, resolved to the task ids it routes between, in
 * published order. `loopBack` marks the edge that returns a bounded loop's
 * body to its loop node.
 */
export type KestraFlowSequencedEdge = Readonly<{
  fromTaskId: string;
  toTaskId: string;
  outcome?: BuilderKey;
  loopBack: boolean;
}>;

/**
 * The workflow's exact published trigger, carried whole and registered
 * disabled. Activation, not compilation, decides when it may start work.
 */
export type KestraFlowTrigger = Readonly<{
  id: string;
  kind: WorkflowTrigger["kind"];
  disabled: true;
  trigger: WorkflowTrigger;
}>;

/**
 * A deterministic, inactive provider flow candidate. It is pure data: no I/O
 * produced it and nothing here has executed, registered or enabled it.
 * Labels are diagnostic only and never select or authorise a flow.
 */
export type KestraFlowCandidate = Readonly<{
  namespace: string;
  id: string;
  /** The exact published workflow revision compiled into this candidate. */
  workflowRevision: number;
  /** Always false: a compiled candidate is prepared, never active. */
  active: false;
  trigger: KestraFlowTrigger;
  tasks: readonly KestraFlowTask[];
  edges: readonly KestraFlowSequencedEdge[];
  maximumNestingDepth: number;
  labels: Readonly<Record<string, string>>;
}>;

/**
 * Why one published workflow could not produce a candidate. The reason is
 * stable reporting metadata: it never selects a definition or changes
 * authority.
 */
export const kestraFlowCompilerRefusalReasons = [
  "invalid_input",
  "invalid_identity",
  "invalid_definition",
  "duplicate_node_id",
  "missing_start_node",
  "multiple_start_nodes",
  "unknown_edge_node",
  "self_edge",
  "duplicate_edge",
  "invalid_outcome_routing",
  "graph_cycle",
  "unreachable_node",
  "unsupported_node",
  "unsupported_trigger",
  "depth_exceeded",
] as const;

export type KestraFlowCompilerRefusalReason = (typeof kestraFlowCompilerRefusalReasons)[number];

export type KestraFlowCompilation =
  | Readonly<{ outcome: "compiled"; flow: KestraFlowCandidate }>
  | Readonly<{ outcome: "refused"; reason: KestraFlowCompilerRefusalReason }>;

/** Kestra's identifier ceilings; a longer derived identifier is refused, never truncated. */
const maximumNamespaceLength = 150;
const maximumFlowIdLength = 100;

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean => Object.keys(value).every((key) => allowed.includes(key));

const refused = (reason: KestraFlowCompilerRefusalReason): KestraFlowCompilation => ({
  outcome: "refused",
  reason,
});

const isEnvironment = (value: unknown): value is KestraFlowCompilerEnvironment =>
  typeof value === "string" &&
  (kestraFlowCompilerEnvironments as readonly string[]).includes(value);

/**
 * Validates exactly the six identity fields; every missing or added field is
 * refused. UUIDs are canonicalised to lower case so one identity always
 * derives one namespace, flow id and label set.
 */
const parseIdentity = (candidate: unknown): KestraFlowIdentity | undefined => {
  if (
    !isObject(candidate) ||
    !hasOnlyKeys(candidate, [
      "environment",
      "organizationId",
      "applicationRootId",
      "applicationVersion",
      "installationRevision",
      "workflowRevision",
    ])
  )
    return undefined;
  if (!isEnvironment(candidate.environment)) return undefined;

  const organizationId = organizationIdSchema.safeParse(candidate.organizationId);
  const applicationRootId = applicationRootIdSchema.safeParse(candidate.applicationRootId);
  const applicationVersion = stableDefinitionReleaseVersionSchema.safeParse(
    candidate.applicationVersion,
  );
  const installationRevision = revisionSchema.safeParse(candidate.installationRevision);
  const workflowRevision = revisionSchema.safeParse(candidate.workflowRevision);
  if (
    !organizationId.success ||
    !applicationRootId.success ||
    !applicationVersion.success ||
    !installationRevision.success ||
    !workflowRevision.success
  )
    return undefined;

  return {
    environment: candidate.environment,
    organizationId: organizationId.data.toLowerCase() as OrganizationId,
    applicationRootId: applicationRootId.data.toLowerCase() as ApplicationRootId,
    applicationVersion: applicationVersion.data,
    installationRevision: installationRevision.data,
    workflowRevision: workflowRevision.data,
  };
};

/**
 * The parsed schema pairs each node type with its own config at runtime, but
 * the inferred WorkflowNode type does not narrow config by type, so the few
 * config fields read here are typed through these views.
 */
type DecisionTableConfig = Readonly<{ decisions: readonly Readonly<{ output: string }>[] }>;
type RequestFormConfig = Readonly<{ timeoutOutcome: string }>;
type StartWorkflowConfig = Readonly<{ workflowId: string }>;

/** The outcomes each routing node must publish exactly once, as publication requires. */
const requiredOutcomes = (node: WorkflowNode): readonly string[] | undefined => {
  switch (node.type) {
    case "condition":
      return ["matched", "not_matched"];
    case "decision_table":
      return (node.config as DecisionTableConfig).decisions.map((decision) => decision.output);
    case "bounded_loop":
      return ["record", "completed"];
    case "request_form":
      return ["submitted", (node.config as RequestFormConfig).timeoutOutcome];
    default:
      return undefined;
  }
};

type ValidatedGraph = Readonly<{
  taskIdByNodeId: ReadonlyMap<string, string>;
  loopBackEdges: ReadonlySet<WorkflowEdge>;
}>;

// Removal point (Phase 9): this repeat of the graph structure, routing, reachability and cycle checks is
// superseded by the one flow validator (runtime/definition/src/flow-validation.ts, #985). Durable
// workflows keep their node-and-edge shape until Phase 9 converts them to durable flows, so it stays
// until then.

/**
 * Rejects a graph that cannot compile to one exact Kestra candidate, applying
 * the same structural rules publication does: one start, known and unique
 * edges, complete outcome routing, full reachability, and only bounded-loop
 * cycles. Returns the resolved task ids and the loop-back edges when valid.
 */
const validateGraph = (definition: WorkflowDefinition): ValidatedGraph | KestraFlowCompilation => {
  const nodeById = new Map<string, WorkflowNode>();
  const taskIdByNodeId = new Map<string, string>();
  const taskIds = new Set<string>();
  for (const node of definition.nodes) {
    const taskId = `t_${node.nodeId.toLowerCase()}`;
    if (nodeById.has(node.nodeId) || taskIds.has(taskId)) return refused("duplicate_node_id");
    if (!(workflowNodeTypeKeys as readonly string[]).includes(node.type))
      return refused("unsupported_node");
    nodeById.set(node.nodeId, node);
    taskIdByNodeId.set(node.nodeId, taskId);
    taskIds.add(taskId);
  }

  const starts = definition.nodes.filter((node) => node.type === "start");
  if (starts.length === 0) return refused("missing_start_node");
  if (starts.length > 1) return refused("multiple_start_nodes");
  const startNodeId = starts[0]!.nodeId;

  const outgoing = new Map<string, WorkflowEdge[]>(
    definition.nodes.map((node) => [node.nodeId, []]),
  );
  const edgeKeys = new Set<string>();
  for (const edge of definition.edges) {
    if (!nodeById.has(edge.fromNodeId) || !nodeById.has(edge.toNodeId))
      return refused("unknown_edge_node");
    const edgeKey = `${edge.fromNodeId}\0${edge.toNodeId}\0${edge.outcome ?? ""}`;
    if (edgeKeys.has(edgeKey)) return refused("duplicate_edge");
    edgeKeys.add(edgeKey);
    outgoing.get(edge.fromNodeId)!.push(edge);
  }

  for (const node of definition.nodes) {
    const nodeEdges = outgoing.get(node.nodeId)!;
    if (node.type === "stop" && nodeEdges.length > 0) return refused("invalid_outcome_routing");
    const expected = requiredOutcomes(node);
    if (expected === undefined) continue;
    const actual = nodeEdges.map((edge) => edge.outcome);
    if (
      new Set(actual).size !== actual.length ||
      actual.length !== expected.length ||
      expected.some((outcome) => !actual.includes(outcome))
    )
      return refused("invalid_outcome_routing");
  }

  // Only a bounded loop's `record` edge may return to the node it leaves.
  for (const edge of definition.edges)
    if (
      edge.fromNodeId === edge.toNodeId &&
      !(nodeById.get(edge.fromNodeId)!.type === "bounded_loop" && edge.outcome === "record")
    )
      return refused("self_edge");

  const reachable = new Set<string>([startNodeId]);
  const queue = [startNodeId];
  while (queue.length > 0)
    for (const edge of outgoing.get(queue.shift()!)!)
      if (!reachable.has(edge.toNodeId)) {
        reachable.add(edge.toNodeId);
        queue.push(edge.toNodeId);
      }
  if (reachable.size !== definition.nodes.length) return refused("unreachable_node");

  // Publication's cycle rule: every cycle holds exactly one bounded loop whose
  // `record` edge stays inside the cycle and whose `completed` edge leaves it.
  let unboundedCycle = false;
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visitCycle = (nodeId: string, path: readonly string[]): void => {
    if (unboundedCycle) return;
    if (visiting.has(nodeId)) {
      const cycleIds = new Set(path.slice(path.indexOf(nodeId)));
      const loops = [...cycleIds].filter((id) => nodeById.get(id)!.type === "bounded_loop");
      const loopEdges = loops.length === 1 ? outgoing.get(loops[0]!)! : [];
      unboundedCycle = !(
        loops.length === 1 &&
        loopEdges.some((edge) => edge.outcome === "record" && cycleIds.has(edge.toNodeId)) &&
        loopEdges.some((edge) => edge.outcome === "completed" && !cycleIds.has(edge.toNodeId))
      );
      return;
    }
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const edge of outgoing.get(nodeId)!) visitCycle(edge.toNodeId, [...path, nodeId]);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const node of definition.nodes) visitCycle(node.nodeId, []);
  if (unboundedCycle) return refused("graph_cycle");

  // A loop-back edge enters a bounded loop from its own body: a node reached
  // from the loop's `record` edge without passing back through the loop.
  const loopBackEdges = new Set<WorkflowEdge>();
  for (const node of definition.nodes) {
    if (node.type !== "bounded_loop") continue;
    const recordEdge = outgoing.get(node.nodeId)!.find((edge) => edge.outcome === "record")!;
    const body = new Set<string>();
    const pending: string[] = recordEdge.toNodeId === node.nodeId ? [] : [recordEdge.toNodeId];
    while (pending.length > 0) {
      const current = pending.shift()!;
      if (body.has(current)) continue;
      body.add(current);
      for (const edge of outgoing.get(current)!)
        if (edge.toNodeId !== node.nodeId) pending.push(edge.toNodeId);
    }
    for (const edge of definition.edges)
      if (
        edge.toNodeId === node.nodeId &&
        (body.has(edge.fromNodeId) || edge === recordEdge)
      )
        loopBackEdges.add(edge);
  }

  // Without loop-back edges the sequencing graph must be acyclic.
  const indegree = new Map<string, number>(definition.nodes.map((node) => [node.nodeId, 0]));
  for (const edge of definition.edges)
    if (!loopBackEdges.has(edge)) indegree.set(edge.toNodeId, indegree.get(edge.toNodeId)! + 1);
  const ready = definition.nodes
    .filter((node) => indegree.get(node.nodeId) === 0)
    .map((node) => node.nodeId);
  let ordered = 0;
  while (ready.length > 0) {
    const nodeId = ready.shift()!;
    ordered += 1;
    for (const edge of outgoing.get(nodeId)!) {
      if (loopBackEdges.has(edge)) continue;
      const remaining = indegree.get(edge.toNodeId)! - 1;
      indegree.set(edge.toNodeId, remaining);
      if (remaining === 0) ready.push(edge.toNodeId);
    }
  }
  if (ordered !== definition.nodes.length) return refused("graph_cycle");

  // Nesting depth counts child-workflow levels from this workflow at depth 1,
  // as publication does. A child naming this workflow never terminates; deeper
  // chains through other definitions were checked when the release published.
  const children = definition.nodes.filter((node) => node.type === "start_workflow");
  if (
    children.some(
      (node) =>
        (node.config as StartWorkflowConfig).workflowId.toLowerCase() ===
        definition.workflowId.toLowerCase(),
    )
  )
    return refused("graph_cycle");
  if ((children.length > 0 ? 2 : 1) > definition.maximumNestingDepth)
    return refused("depth_exceeded");

  return { taskIdByNodeId, loopBackEdges };
};

const compileTrigger = (trigger: WorkflowTrigger): KestraFlowTrigger => ({
  id: `trigger_${trigger.kind}`,
  kind: trigger.kind,
  disabled: true,
  trigger,
});

/**
 * Compiles one exact published workflow and its installation identity into a
 * deterministic inactive Kestra flow candidate, or refuses with a stable typed
 * reason. The same definition and identity always yield the same candidate:
 * the namespace and flow id are derived only from the environment,
 * organisation, installation, application, workflow and revision identity, and
 * the tasks, edges and trigger come only from the published definition, in
 * published order.
 *
 * This function is pure. It performs no I/O, signs nothing, registers nothing
 * and enables nothing, and it never invents an identity from its inputs.
 */
export const compileKestraFlow = (inputCandidate: unknown): KestraFlowCompilation => {
  if (!isObject(inputCandidate) || !hasOnlyKeys(inputCandidate, ["definition", "identity"]))
    return refused("invalid_input");

  const identity = parseIdentity(inputCandidate.identity);
  if (identity === undefined) return refused("invalid_identity");

  const parsedDefinition = workflowDefinitionSchema.safeParse(inputCandidate.definition);
  if (!parsedDefinition.success) return refused("invalid_definition");
  const definition = parsedDefinition.data;

  const graph = validateGraph(definition);
  if ("outcome" in graph) return graph;

  let trigger: KestraFlowTrigger;
  switch (definition.trigger.kind) {
    case "event":
    case "schedule":
    case "incoming_message":
    case "button":
    case "interface":
    case "workflow":
      trigger = compileTrigger(definition.trigger);
      break;
    default:
      return refused("unsupported_trigger");
  }

  const workflowId = definition.workflowId.toLowerCase();
  const namespace = [
    "vortex",
    "application",
    identity.environment,
    identity.organizationId,
    identity.applicationRootId,
    `i${identity.installationRevision}`,
  ].join(".");
  const id = [
    "w",
    workflowId,
    identity.applicationVersion.replaceAll(".", "-"),
    `r${identity.workflowRevision}`,
  ].join("_");
  if (namespace.length > maximumNamespaceLength || id.length > maximumFlowIdLength)
    return refused("invalid_identity");

  const predecessors = new Map<string, Set<string>>(
    definition.nodes.map((node) => [node.nodeId, new Set<string>()]),
  );
  for (const edge of definition.edges)
    if (!graph.loopBackEdges.has(edge))
      predecessors.get(edge.toNodeId)!.add(graph.taskIdByNodeId.get(edge.fromNodeId)!);

  const tasks: readonly KestraFlowTask[] = Object.freeze(
    definition.nodes.map((node) =>
      Object.freeze({
        id: graph.taskIdByNodeId.get(node.nodeId)!,
        kind: "protected_operation_callback" as const,
        operation: Object.freeze({
          contractVersion: kestraProtectedOperationContractVersion,
          organizationId: identity.organizationId,
          applicationRootId: identity.applicationRootId,
          workflowRevision: identity.workflowRevision,
          nodeId: node.nodeId,
          operationKey: `workflow.node.${node.type}`,
        }),
        node,
        dependsOn: Object.freeze([...predecessors.get(node.nodeId)!].sort()),
      }),
    ),
  );

  const edges: readonly KestraFlowSequencedEdge[] = Object.freeze(
    definition.edges.map((edge) =>
      Object.freeze({
        fromTaskId: graph.taskIdByNodeId.get(edge.fromNodeId)!,
        toTaskId: graph.taskIdByNodeId.get(edge.toNodeId)!,
        ...(edge.outcome === undefined ? {} : { outcome: edge.outcome }),
        loopBack: graph.loopBackEdges.has(edge),
      }),
    ),
  );

  const flow: KestraFlowCandidate = Object.freeze({
    namespace,
    id,
    workflowRevision: identity.workflowRevision,
    active: false,
    trigger: Object.freeze(trigger),
    tasks,
    edges,
    maximumNestingDepth: definition.maximumNestingDepth,
    labels: Object.freeze({
      vortex_environment: identity.environment,
      vortex_organization_id: identity.organizationId,
      vortex_application_root_id: identity.applicationRootId,
      vortex_application_version: identity.applicationVersion,
      vortex_installation_revision: String(identity.installationRevision),
      vortex_workflow_id: workflowId,
      vortex_workflow_key: definition.key,
      vortex_workflow_revision: String(identity.workflowRevision),
    }),
  });

  return { outcome: "compiled", flow };
};
