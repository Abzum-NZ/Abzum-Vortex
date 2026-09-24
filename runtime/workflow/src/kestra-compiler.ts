import "server-only";

import {
  applicationRootIdSchema,
  organizationIdSchema,
  revisionSchema,
  semanticVersionSchema,
  workflowDefinitionSchema,
  workflowNodeTypeKeys,
  type ApplicationRootId,
  type BuilderKey,
  type OrganizationId,
  type SemanticVersion,
  type WorkflowDefinition,
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
 * `installationRevision` is the active installation's Application release
 * revision; `workflowRevision` is the exact published workflow revision. Every
 * value is permanent Vortex identity, never a mutable label or provider key.
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

/**
 * One generic Kestra callback task. Every published node compiles to the same
 * callback shape and the exact published node is retained for the later
 * per-node provider mapping; no per-application behaviour lives here.
 * `dependsOn` is the deterministic set of predecessor task ids, so the task
 * graph sequences exactly as the published edges require.
 */
export type KestraFlowTask = Readonly<{
  id: string;
  kind: "protected_operation_callback";
  node: WorkflowNode;
  dependsOn: readonly string[];
}>;

/** One published edge, resolved to the task ids it sequences. */
export type KestraFlowSequencedEdge = Readonly<{
  fromTaskId: string;
  toTaskId: string;
  outcome?: BuilderKey;
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
  revision: number;
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

/** Node kinds whose nesting is measured against the published depth ceiling. */
const nestingNodeTypes: ReadonlySet<WorkflowNode["type"]> = new Set([
  "condition",
  "decision_table",
  "bounded_loop",
  "start_workflow",
]);

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

/** One namespace segment other than the environment and revision counters. */
const namespaceSegment = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

const isEnvironment = (value: unknown): value is KestraFlowCompilerEnvironment =>
  typeof value === "string" &&
  (kestraFlowCompilerEnvironments as readonly string[]).includes(value);

/** Validates exactly the six identity fields; every missing or added field is refused. */
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
  const applicationVersion = semanticVersionSchema.safeParse(candidate.applicationVersion);
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
    organizationId: organizationId.data,
    applicationRootId: applicationRootId.data,
    applicationVersion: applicationVersion.data,
    installationRevision: installationRevision.data,
    workflowRevision: workflowRevision.data,
  };
};

/**
 * Rejects a graph that cannot compile to one exact Kestra candidate: duplicate
 * ids, a missing or repeated start, edges naming unknown nodes, self-edges, a
 * cycle, an unreachable node, or nesting deeper than the published ceiling.
 * Returns the resolved task ids when the graph is valid.
 */
const validateGraph = (
  definition: WorkflowDefinition,
): Readonly<{ taskIdByNodeId: Map<string, string>; startNodeId: string }> | KestraFlowCompilation => {
  const taskIdByNodeId = new Map<string, string>();
  const nodeById = new Map<string, WorkflowNode>();
  for (const node of definition.nodes) {
    if (nodeById.has(node.nodeId)) return refused("duplicate_node_id");
    if (!(workflowNodeTypeKeys as readonly string[]).includes(node.type))
      return refused("unsupported_node");
    nodeById.set(node.nodeId, node);
    taskIdByNodeId.set(node.nodeId, `t_${node.nodeId}`);
  }

  const starts = definition.nodes.filter((node) => node.type === "start");
  if (starts.length === 0) return refused("missing_start_node");
  if (starts.length > 1) return refused("multiple_start_nodes");
  const startNodeId = starts[0]!.nodeId;

  const successors = new Map<string, string[]>(
    definition.nodes.map((node) => [node.nodeId, []]),
  );
  const predecessors = new Map<string, string[]>(
    definition.nodes.map((node) => [node.nodeId, []]),
  );
  for (const edge of definition.edges) {
    if (!nodeById.has(edge.fromNodeId) || !nodeById.has(edge.toNodeId))
      return refused("unknown_edge_node");
    if (edge.fromNodeId === edge.toNodeId) return refused("self_edge");
    successors.get(edge.fromNodeId)!.push(edge.toNodeId);
    predecessors.get(edge.toNodeId)!.push(edge.fromNodeId);
  }

  const colours = new Map<string, "white" | "grey" | "black">(
    definition.nodes.map((node) => [node.nodeId, "white" as const]),
  );
  const visit = (nodeId: string): boolean => {
    colours.set(nodeId, "grey");
    for (const next of successors.get(nodeId)!) {
      const colour = colours.get(next);
      if (colour === "grey") return true;
      if (colour === "white" && visit(next)) return true;
    }
    colours.set(nodeId, "black");
    return false;
  };
  for (const node of definition.nodes)
    if (colours.get(node.nodeId) === "white" && visit(node.nodeId))
      return refused("graph_cycle");

  const reachable = new Set<string>([startNodeId]);
  const queue = [startNodeId];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    for (const next of successors.get(nodeId)!)
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
  }
  if (reachable.size !== definition.nodes.length) return refused("unreachable_node");

  // Depth is the count of decision, loop and child-workflow nodes on the
  // longest path. Cross-definition child chains are checked at registration.
  const indegree = new Map<string, number>(
    definition.nodes.map((node) => [node.nodeId, predecessors.get(node.nodeId)!.length]),
  );
  const depth = new Map<string, number>();
  const ready = definition.nodes
    .filter((node) => indegree.get(node.nodeId) === 0)
    .map((node) => node.nodeId);
  while (ready.length > 0) {
    const nodeId = ready.shift()!;
    const node = nodeById.get(nodeId)!;
    const predecessorDepth = predecessors.get(nodeId)!.reduce(
      (highest, predecessor) => Math.max(highest, depth.get(predecessor) ?? 0),
      0,
    );
    const currentDepth = predecessorDepth + (nestingNodeTypes.has(node.type) ? 1 : 0);
    if (currentDepth > definition.maximumNestingDepth) return refused("depth_exceeded");
    depth.set(nodeId, currentDepth);
    for (const next of successors.get(nodeId)!) {
      const remaining = indegree.get(next)! - 1;
      indegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }

  return { taskIdByNodeId, startNodeId };
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
 * the tasks, edges and trigger come only from the published definition.
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

  const predecessors = new Map<string, Set<string>>(
    definition.nodes.map((node) => [node.nodeId, new Set<string>()]),
  );
  for (const edge of definition.edges) predecessors.get(edge.toNodeId)!.add(edge.fromNodeId);

  const tasks: KestraFlowTask[] = definition.nodes.map((node) => ({
    id: graph.taskIdByNodeId.get(node.nodeId)!,
    kind: "protected_operation_callback",
    node,
    dependsOn: [...predecessors.get(node.nodeId)!]
      .map((predecessor) => graph.taskIdByNodeId.get(predecessor)!)
      .sort(),
  }));

  const edges: KestraFlowSequencedEdge[] = definition.edges.map((edge) => ({
    fromTaskId: graph.taskIdByNodeId.get(edge.fromNodeId)!,
    toTaskId: graph.taskIdByNodeId.get(edge.toNodeId)!,
    ...(edge.outcome === undefined ? {} : { outcome: edge.outcome }),
  }));

  const namespace = [
    "vortex",
    "application",
    identity.environment,
    namespaceSegment(identity.organizationId),
    namespaceSegment(identity.applicationRootId),
    `i${identity.installationRevision}`,
  ].join(".");
  const id = [
    "w",
    namespaceSegment(definition.workflowId),
    namespaceSegment(identity.applicationVersion),
    `r${identity.workflowRevision}`,
  ].join("_");

  const flow: KestraFlowCandidate = Object.freeze({
    namespace,
    id,
    revision: identity.workflowRevision,
    active: false,
    trigger,
    tasks,
    edges,
    maximumNestingDepth: definition.maximumNestingDepth,
    labels: Object.freeze({
      vortex_environment: identity.environment,
      vortex_organization_id: identity.organizationId,
      vortex_application_root_id: identity.applicationRootId,
      vortex_application_version: identity.applicationVersion,
      vortex_installation_revision: String(identity.installationRevision),
      vortex_workflow_id: definition.workflowId,
      vortex_workflow_key: definition.key,
      vortex_workflow_revision: String(identity.workflowRevision),
    }),
  });

  return { outcome: "compiled", flow };
};
