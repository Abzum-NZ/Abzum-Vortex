import "server-only";

import { createHash } from "node:crypto";

import {
  applicationRootIdSchema,
  flowControlTaskTypeKeys,
  flowSchema,
  flowTaskRegistry,
  isFlowControlTask,
  organizationIdSchema,
  revisionSchema,
  stableDefinitionReleaseVersionSchema,
  type ApplicationRootId,
  type FlowDefinition,
  type FlowFormula,
  type FlowLiteral,
  type FlowTask,
  type FlowTaskTypeKey,
  type FlowTrigger,
  type FlowValue,
  type JsonValue,
  type OrganizationId,
  type ProtectedOperationRequest,
  type SemanticVersion,
} from "@vortex/contracts";
import {
  legacyWorkflowDefinitionSchema,
  legacyWorkflowNodeTypeKeys,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowTrigger,
} from "./legacy-workflow-definition";

/**
 * The permanent environment a candidate flow is scoped to. The generated
 * namespace starts with this value, so a candidate from one environment can
 * never collide with or be selected as a candidate from another.
 */
export const kestraFlowCompilerEnvironments = ["local", "testing", "production"] as const;

export type KestraFlowCompilerEnvironment = (typeof kestraFlowCompilerEnvironments)[number];

/**
 * The exact identities one published durable flow candidate is generated from.
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

/**
 * One published durable flow plus the identity it is installed under.
 * `childFlowRevisions` optionally pins the exact workflow revision of every
 * `run_flow` target the release published, keyed by lower-case permanent flow
 * identity, so a Subflow can name the child's exact generated Kestra flow id.
 */
export type KestraFlowCompilerInput = Readonly<{
  definition: FlowDefinition;
  identity: KestraFlowIdentity;
  childFlowRevisions?: Readonly<Record<string, number>>;
}>;

/** The protected-operation envelope version every compiled callback task sends. */
export const kestraProtectedOperationContractVersion = "1.0.0";

/**
 * The single generic Kestra callback task every effect, every condition and
 * every formula compiles to. It is a platform-provided task (issue #664 owns
 * the endpoint it reaches): it signs the envelope with the fixed callback key
 * and calls the protected-operation endpoint exactly once per attempt.
 */
export const kestraProtectedCallbackTaskType = "io.kestra.plugin.vortex.ProtectedCallback";

/**
 * The one secret a compiled flow may reference. The application Kestra instance
 * environment holds no other secret, so a customer flow can read only this key
 * and never an operational delivery, database or provider secret.
 */
export const kestraCallbackKeyReference = "{{ secret('VORTEX_WORKFLOW_CALLBACK_KEY') }}";

/** The operator key the evaluator callback uses for every condition and formula. */
export const kestraEvaluatorOperationKey = "workflow.evaluate";

/** The operator key the human-task callback uses for a durable Wait for a person. */
export const kestraHumanTaskOperationKey = "workflow.human_task";

/**
 * The signed protected-operation envelope fields fixed at compile time. They
 * come only from the validated identity and the published task, so a callback
 * can never name another organisation, application, revision or task.
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
    | "inputs"
  >
>;

/**
 * The envelope fields Vortex binds and signs per execution attempt. The
 * compiler never supplies them: no run, attempt, time, duplicate key or caller
 * proof exists at compile time.
 */
export const kestraProtectedOperationRuntimeFields = [
  "runId",
  "attempt",
  "issuedAt",
  "expiresAt",
  "duplicateProtectionKey",
  "signedCallerProof",
] as const satisfies readonly Exclude<
  keyof ProtectedOperationRequest,
  keyof KestraProtectedOperationBinding
>[];

/** One permanent task-to-node binding the retained run authority uses at execution time. */
export type KestraFlowNodeBinding = Readonly<{
  taskId: string;
  nodeId: string;
  operationKey: string;
}>;

/**
 * One compiled Kestra task as plain data. Its shape is exactly the Kestra flow
 * step it renders to; nested task lists live under the control task's own keys.
 */
export type KestraCompiledTask = Readonly<Record<string, JsonValue>>;

/**
 * The workflow's exact published trigger, carried whole and registered
 * disabled. Activation, not compilation, decides when it may start work.
 */
export type KestraFlowTrigger = Readonly<{
  id: string;
  /**
   * The start kind the registration and readiness contracts understand. Durable flows use
   * `schedule`, `incoming_message` or `workflow` (started only by Run background flow);
   * legacy node-and-edge workflows keep their own published start kind.
   */
  kind: "schedule" | "incoming_message" | "workflow" | WorkflowTrigger["kind"];
  disabled: true;
  trigger: FlowTrigger | null;
}>;

/**
 * A deterministic, inactive provider flow candidate. It is pure data: no I/O
 * produced it and nothing here has executed, registered or enabled it.
 * `yaml` is the exact Kestra flow the candidate registers; labels are
 * diagnostic only and never select or authorise a flow.
 */
export type KestraFlowCandidate = Readonly<{
  namespace: string;
  id: string;
  /** The exact published workflow revision compiled into this candidate. */
  workflowRevision: number;
  /** Always false: a compiled candidate is prepared, never active. */
  active: false;
  trigger: KestraFlowTrigger;
  triggers: readonly KestraFlowTrigger[];
  tasks: readonly KestraCompiledTask[];
  /** Every callback node this flow binds, so retained-run authority can be read back. */
  nodes: readonly KestraFlowNodeBinding[];
  labels: Readonly<Record<string, string>>;
  /** The rendered Kestra flow YAML. */
  yaml: string;
}>;

/**
 * Why one published flow could not produce a candidate. The reason is stable
 * reporting metadata: it never selects a definition or changes authority.
 */
export const kestraFlowCompilerRefusalReasons = [
  "invalid_input",
  "invalid_identity",
  "invalid_definition",
  "not_durable",
  "unsupported_trigger",
  "unsupported_task",
  "unsupported_node",
  "unresolved_child_flow_revision",
  "duplicate_switch_case",
  "duplicate_node_id",
  "missing_start_node",
  "multiple_start_nodes",
  "unknown_edge_node",
  "self_edge",
  "duplicate_edge",
  "invalid_outcome_routing",
  "graph_cycle",
  "unreachable_node",
  "depth_exceeded",
  "template_text",
  "unsafe_builder_text",
] as const;

export type KestraFlowCompilerRefusalReason = (typeof kestraFlowCompilerRefusalReasons)[number];

export type KestraFlowCompilation =
  | Readonly<{ outcome: "compiled"; flow: KestraFlowCandidate }>
  | Readonly<{ outcome: "refused"; reason: KestraFlowCompilerRefusalReason }>;

/** Kestra's identifier ceilings; a longer derived identifier is refused, never truncated. */
const maximumNamespaceLength = 150;
const maximumFlowIdLength = 100;

const templateDelimiterPattern = /\{\{|\{%/;
const hasTemplateDelimiter = (value: string): boolean => templateDelimiterPattern.test(value);

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

// ─── Determinism ─────────────────────────────────────────────────────────────────────────────

/** Canonical JSON with sorted keys and omitted undefined, so equal data always hashes equally. */
const canonicalJson = (value: JsonValue): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member as JsonValue)}`)
    .join(",")}}`;
};

/** The fixed UUID namespace one callback node id is derived under. */
const callbackNodeIdNamespace = "8f7d4f2a-6c31-4b0e-9f5a-2d1c3b4a5e60";

/**
 * Derives the permanent node id of one published task. The same identity,
 * flow and task always yield the same UUID, and no two tasks of one flow
 * collide, so retained-run authority can be rebuilt without extra state.
 */
const deriveNodeId = (
  identity: KestraFlowIdentity,
  flowId: string,
  taskId: string,
): string => {
  const name = [
    identity.environment,
    identity.organizationId,
    identity.applicationRootId,
    String(identity.installationRevision),
    String(identity.workflowRevision),
    flowId,
    taskId,
  ].join("|");
  const namespaceBytes = Buffer.from(callbackNodeIdNamespace.replaceAll("-", ""), "hex");
  const digest = createHash("sha1").update(namespaceBytes).update(Buffer.from(name, "utf8")).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** A Kestra task id from a prefix and a published task key; builder keys are already safe. */
const kestraTaskId = (prefix: string, seed: string): string => `${prefix}_${seed}`;

// ─── Compilation context ─────────────────────────────────────────────────────────────────────

type CompileContext = {
  readonly identity: KestraFlowIdentity;
  readonly flow: FlowDefinition;
  readonly childFlowRevisions: ReadonlyMap<string, number>;
  readonly allowedTemplateTokens: Set<string>;
  readonly nodes: KestraFlowNodeBinding[];
  /** True inside a loop body, where each iteration reads its own sibling outputs. */
  readonly insideLoop: boolean;
};

type CompileOutcome<Value> =
  | Readonly<{ outcome: "ok"; value: Value }>
  | Readonly<{ outcome: "refused"; reason: KestraFlowCompilerRefusalReason }>;

const ok = <Value>(value: Value): CompileOutcome<Value> => ({ outcome: "ok", value });
const stop = <Value>(reason: KestraFlowCompilerRefusalReason): CompileOutcome<Value> => ({
  outcome: "refused",
  reason,
});

/** The exact installation namespace every flow of one candidate release is generated under. */
const installationNamespace = (identity: KestraFlowIdentity): string =>
  [
    "vortex",
    "application",
    identity.environment,
    identity.organizationId,
    identity.applicationRootId,
    `i${identity.installationRevision}`,
  ].join(".");

/** The exact generated Kestra flow id of one published flow of this release. */
const generatedFlowId = (
  identity: KestraFlowIdentity,
  flowUuid: string,
  workflowRevision: number,
): string =>
  [
    "w",
    flowUuid.toLowerCase(),
    identity.applicationVersion.replaceAll(".", "-"),
    `r${workflowRevision}`,
  ].join("_");

// ─── The generic callback ────────────────────────────────────────────────────────────────────

/** Raw-wrapped JSON keeps builder text inert: Pebble never evaluates inside the block. */
const rawJson = (value: JsonValue): string => `{% raw %}${canonicalJson(value)}{% endraw %}`;

/** The part of a compile context every generic callback needs, shared by both input shapes. */
type CallbackContext = {
  readonly identity: KestraFlowIdentity;
  readonly allowedTemplateTokens: Set<string>;
  readonly nodes: KestraFlowNodeBinding[];
  readonly insideLoop: boolean;
};

/** The compiler-generated reference to the current loop item, sent with every callback in a loop. */
const loopItemReference = "{{ taskrun.value }}";

/**
 * The compiler-generated reference to one evaluator callback's result. Inside a loop body Kestra
 * keys sibling outputs by iteration, so the reference reads the current iteration's output.
 */
const resultReference = (ctx: CallbackContext, taskId: string): string => {
  const reference = ctx.insideLoop
    ? `{{ currentEachOutput(outputs.${taskId}).value }}`
    : `{{ outputs.${taskId}.value }}`;
  ctx.allowedTemplateTokens.add(reference);
  return reference;
};

const callbackBinding = (
  ctx: CallbackContext,
  nodeId: string,
  operationKey: string,
  inputs: Record<string, JsonValue>,
): KestraProtectedOperationBinding => ({
  contractVersion: kestraProtectedOperationContractVersion,
  organizationId: ctx.identity.organizationId,
  applicationRootId: ctx.identity.applicationRootId,
  workflowRevision: ctx.identity.workflowRevision,
  nodeId: nodeId as ProtectedOperationRequest["nodeId"],
  operationKey: operationKey as ProtectedOperationRequest["operationKey"],
  inputs: inputs as ProtectedOperationRequest["inputs"],
});

/**
 * One generic protected callback carrying the signed envelope binding and the
 * typed JSON inputs Vortex evaluates. The task references only the fixed
 * callback key, and its envelope JSON is raw-wrapped so no builder value is
 * ever evaluated as template text.
 */
const protectedCallbackTask = (
  ctx: CallbackContext,
  taskId: string,
  nodeId: string,
  operationKey: string,
  inputs: Record<string, JsonValue>,
): KestraCompiledTask => {
  const binding = callbackBinding(ctx, nodeId, operationKey, inputs);
  ctx.allowedTemplateTokens.add(kestraCallbackKeyReference);
  ctx.nodes.push({
    taskId,
    nodeId: binding.nodeId as string,
    operationKey: binding.operationKey,
  });
  if (ctx.insideLoop) ctx.allowedTemplateTokens.add(loopItemReference);
  return {
    id: taskId,
    type: kestraProtectedCallbackTaskType,
    envelope: rawJson(binding as unknown as JsonValue),
    callbackKey: kestraCallbackKeyReference,
    ...(ctx.insideLoop ? { loopItem: loopItemReference } : {}),
  };
};

/** The deterministic node id of one published task of the flow being compiled. */
const derivedNodeId = (ctx: CompileContext, seed: string): string =>
  deriveNodeId(ctx.identity, ctx.flow.id, seed);

const jsonOf = (value: unknown): JsonValue => value as unknown as JsonValue;

type EvaluatedValue = Readonly<{ tasks: KestraCompiledTask[]; reference: string }>;

type ValueExpression = Readonly<{ tasks: KestraCompiledTask[]; expression: JsonValue }>;

/**
 * Compiles one condition, formula or value to an evaluator callback and the
 * Kestra reference to its result. Kestra's native control tasks branch only on
 * this reference; the Vortex evaluator owns the typed semantics.
 */
const evaluateValue = (
  ctx: CompileContext,
  seed: string,
  value: FlowValue,
  limits: Record<string, JsonValue> = {},
): EvaluatedValue => {
  const taskId = kestraTaskId("e", seed);
  const task = protectedCallbackTask(ctx, taskId, derivedNodeId(ctx, taskId), kestraEvaluatorOperationKey, {
    expression: jsonOf(value),
    ...limits,
  });
  return { tasks: [task], reference: resultReference(ctx, taskId) };
};

const evaluateFormula = (ctx: CompileContext, seed: string, formula: FlowFormula): EvaluatedValue =>
  evaluateValue(ctx, seed, { kind: "formula", formula });

// ─── Values ──────────────────────────────────────────────────────────────────────────────────

/** The inert literal value of a published literal; flowSchema already proved it delimiter-free. */
const literalValue = (literal: FlowLiteral): JsonValue => literal.value;

/**
 * Compiles one Kestra property value. A literal stays an inert literal; a
 * reference or formula becomes an evaluator callback and the generated
 * reference to its result.
 */
const compileValue = (
  ctx: CompileContext,
  seed: string,
  value: FlowValue,
): CompileOutcome<ValueExpression> => {
  if (value.kind === "literal") return ok({ tasks: [], expression: literalValue(value.literal) });
  const evaluated = evaluateValue(ctx, seed, value);
  return ok({ tasks: evaluated.tasks, expression: evaluated.reference });
};

/** The canonical text one switch case compares against. */
const switchCaseKey = (literal: FlowLiteral): string => {
  const value = literal.value;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return canonicalJson(value);
};

// ─── Kestra input types ──────────────────────────────────────────────────────────────────────

/** The Kestra input type one Vortex value type maps to when it must be a typed input. */
const kestraInputType = (vortexType: string): string => {
  switch (vortexType) {
    case "yes_no":
      return "BOOL";
    case "whole_number":
      return "INT";
    case "decimal_number":
    case "money":
      return "FLOAT";
    case "date":
      return "DATE";
    case "date_time":
      return "DATETIME";
    case "json":
    case "record_reference":
    case "record_reference_list":
    case "relationship_reference":
    case "relationship_reference_list":
    case "file_reference":
      return "JSON";
    default:
      return "STRING";
  }
};

/** The declared type of a wait-for-person answer: the literal's own type, else text. */
const valueInputType = (value: FlowValue): string =>
  value.kind === "literal" ? kestraInputType(value.literal.type) : "STRING";

// ─── Control tasks ───────────────────────────────────────────────────────────────────────────

const flowTriggers = (flow: FlowDefinition): readonly FlowTrigger[] => flow.triggers;

/**
 * True when cron can express the recurrence exactly. A cron step restarts at each larger unit, so
 * only hour steps dividing a day, month steps dividing a year and single-day or single-week
 * intervals repeat evenly; anything else is refused rather than approximated.
 */
const scheduleIsExpressible = (recurrence: {
  cadence: "hourly" | "daily" | "weekly" | "monthly";
  interval: number;
}): boolean => {
  switch (recurrence.cadence) {
    case "hourly":
      return 24 % recurrence.interval === 0;
    case "daily":
    case "weekly":
      return recurrence.interval === 1;
    case "monthly":
      return 12 % recurrence.interval === 0;
  }
};

/** The Kestra cron expression one closed recurrence value owns. */
const scheduleCron = (recurrence: {
  cadence: "hourly" | "daily" | "weekly" | "monthly";
  interval: number;
  minute: number;
  hour?: number | undefined;
  weekDay?: number | undefined;
  monthDay?: number | undefined;
}): string => {
  const { cadence, interval, minute } = recurrence;
  switch (cadence) {
    case "hourly":
      return `${minute} */${interval} * * *`;
    case "daily":
      return `${minute} ${recurrence.hour} */${interval} * *`;
    case "weekly":
      return `${minute} ${recurrence.hour} * * ${recurrence.weekDay}`;
    case "monthly":
      return `${minute} ${recurrence.hour} ${recurrence.monthDay} */${interval} *`;
  }
};

/** The deterministic, disabled Webhook key one IncomingMessage trigger owns. */
const webhookKey = (identity: KestraFlowIdentity, flowId: string, messageKey: string): string => {
  const digest = createHash("sha256")
    .update(
      [
        identity.environment,
        identity.organizationId,
        identity.applicationRootId,
        String(identity.installationRevision),
        flowId,
        messageKey,
      ].join("|"),
    )
    .digest("hex");
  return `vortex_${digest.slice(0, 40)}`;
};

/**
 * Compiles one published trigger to its native Kestra trigger, disabled. A
 * Schedule becomes a Kestra Schedule with cron and time zone; an
 * IncomingMessage becomes a Webhook. Nothing else can start a durable flow.
 */
const compileTrigger = (
  ctx: CompileContext,
  trigger: FlowTrigger,
): CompileOutcome<KestraFlowTrigger> => {
  const id = `trigger_${trigger.id}`;
  // Kestra cannot evaluate a Vortex entry condition, and an unenforced condition would start runs
  // the builder excluded, so a conditioned trigger is refused until Vortex gates the start.
  if (trigger.condition !== undefined) return stop("unsupported_trigger");
  if (trigger.type === "Schedule" && !scheduleIsExpressible(trigger.recurrence))
    return stop("unsupported_trigger");
  if (trigger.type === "Schedule")
    return ok({
      id,
      kind: "schedule",
      disabled: true,
      trigger,
    });
  if (trigger.type === "IncomingMessage")
    return ok({
      id,
      kind: "incoming_message",
      disabled: true,
      trigger,
    });
  return stop("unsupported_trigger");
};

const renderTriggerYaml = (
  ctx: CompileContext,
  trigger: FlowTrigger,
): Record<string, JsonValue> => {
  const id = `trigger_${trigger.id}`;
  if (trigger.type === "Schedule")
    return {
      id,
      type: "io.kestra.plugin.core.trigger.Schedule",
      cron: scheduleCron(trigger.recurrence),
      timezone: trigger.recurrence.timeZone,
      disabled: true,
    };
  if (trigger.type === "IncomingMessage")
    return {
      id,
      type: "io.kestra.plugin.core.trigger.Webhook",
      key: webhookKey(ctx.identity, ctx.flow.id, trigger.messageKey),
      disabled: true,
    };
  throw new TypeError("unsupported trigger reached rendering");
};

// ─── Task compilation ────────────────────────────────────────────────────────────────────────

type ControlTask = Extract<FlowTask, { type: (typeof flowControlTaskTypeKeys)[number] }>;

type RegisteredTask = Extract<FlowTask, { properties: unknown }>;

const compileTaskList = (
  ctx: CompileContext,
  tasks: readonly FlowTask[],
): CompileOutcome<KestraCompiledTask[]> => {
  const compiled: KestraCompiledTask[] = [];
  for (const task of tasks) {
    const result = compileTask(ctx, task);
    if (result.outcome === "refused") return result;
    compiled.push(...result.value);
  }
  return ok(compiled);
};

/**
 * A Stop: the published outcome (a builder key) is recorded as an output value, then the
 * execution exits successfully. Kestra's Exit task carries no outputs of its own.
 */
const stopTasks = (seed: string, outcome: string): KestraCompiledTask[] => [
  {
    id: kestraTaskId("o", seed),
    type: "io.kestra.plugin.core.output.OutputValues",
    values: { vortex_outcome: outcome },
  },
  { id: kestraTaskId("c", seed), type: "io.kestra.plugin.core.execution.Exit", state: "SUCCESS" },
];

const compileControlTask = (
  ctx: CompileContext,
  task: ControlTask,
): CompileOutcome<KestraCompiledTask[]> => {
  switch (task.type) {
    case "if": {
      const condition = evaluateFormula(ctx, `${task.id}__condition`, task.condition);
      const then = compileTaskList(ctx, task.then);
      if (then.outcome === "refused") return then;
      const otherwise = task.else ? compileTaskList(ctx, task.else) : ok<KestraCompiledTask[]>([]);
      if (otherwise.outcome === "refused") return otherwise;
      return ok([
        ...condition.tasks,
        {
          id: kestraTaskId("c", task.id),
          type: "io.kestra.plugin.core.flow.If",
          condition: condition.reference,
          then: then.value,
          ...(otherwise.value.length > 0 ? { else: otherwise.value } : {}),
        },
      ]);
    }
    case "switch": {
      const value = evaluateValue(ctx, `${task.id}__value`, task.value);
      const cases: Record<string, JsonValue> = {};
      for (const entry of task.cases) {
        const key = switchCaseKey(entry.when);
        if (Object.hasOwn(cases, key)) return stop("duplicate_switch_case");
        const branch = compileTaskList(ctx, entry.tasks);
        if (branch.outcome === "refused") return branch;
        cases[key] = branch.value as unknown as JsonValue;
      }
      const otherwise = task.default ? compileTaskList(ctx, task.default) : ok<KestraCompiledTask[]>([]);
      if (otherwise.outcome === "refused") return otherwise;
      const sortedCases = Object.fromEntries(
        Object.entries(cases).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
      );
      return ok([
        ...value.tasks,
        {
          id: kestraTaskId("c", task.id),
          type: "io.kestra.plugin.core.flow.Switch",
          value: value.reference,
          cases: sortedCases,
          ...(otherwise.value.length > 0 ? { defaults: otherwise.value } : {}),
        },
      ]);
    }
    case "for_each": {
      // The evaluator refuses a list longer than the published maximum before any iteration runs.
      const items = evaluateValue(ctx, `${task.id}__items`, task.items, {
        maximum_items: task.maximumItems,
      });
      const body = compileTaskList({ ...ctx, insideLoop: true }, task.tasks);
      if (body.outcome === "refused") return body;
      return ok([
        ...items.tasks,
        {
          id: kestraTaskId("c", task.id),
          type: "io.kestra.plugin.core.flow.ForEach",
          values: items.reference,
          tasks: body.value,
        },
      ]);
    }
    case "sequential": {
      const body = compileTaskList(ctx, task.tasks);
      if (body.outcome === "refused") return body;
      return ok([
        { id: kestraTaskId("c", task.id), type: "io.kestra.plugin.core.flow.Sequential", tasks: body.value },
      ]);
    }
    case "parallel": {
      const branches: KestraCompiledTask[] = [];
      for (const [index, branch] of task.branches.entries()) {
        const compiled = compileTaskList(ctx, branch);
        if (compiled.outcome === "refused") return compiled;
        branches.push({
          id: kestraTaskId("c", `${task.id}__branch_${index}`),
          type: "io.kestra.plugin.core.flow.Sequential",
          tasks: compiled.value,
        });
      }
      return ok([
        { id: kestraTaskId("c", task.id), type: "io.kestra.plugin.core.flow.Parallel", tasks: branches },
      ]);
    }
    case "run_flow": {
      const leading: KestraCompiledTask[] = [];
      const inputs: Record<string, JsonValue> = {};
      const names = Object.keys(task.inputs).sort();
      for (const name of names) {
        const compiled = compileValue(ctx, `${task.id}__input_${name}`, task.inputs[name]!);
        if (compiled.outcome === "refused") return compiled;
        leading.push(...compiled.value.tasks);
        inputs[name] = compiled.value.expression;
      }
      const revision = ctx.childFlowRevisions.get(task.flowId.toLowerCase());
      if (revision === undefined) return stop("unresolved_child_flow_revision");
      return ok([
        ...leading,
        {
          id: kestraTaskId("c", task.id),
          type: "io.kestra.plugin.core.flow.Subflow",
          namespace: installationNamespace(ctx.identity),
          flowId: generatedFlowId(ctx.identity, task.flowId, revision),
          inputs,
          wait: true,
        },
      ]);
    }
    case "stop":
      return ok(stopTasks(task.id, task.outcome));
    case "wait_until": {
      const until = evaluateValue(ctx, `${task.id}__until`, task.until);
      return ok([
        ...until.tasks,
        {
          id: kestraTaskId("c", task.id),
          type: "io.kestra.plugin.core.flow.Pause",
          pauseDuration: until.reference,
        },
      ]);
    }
    case "wait_for_person": {
      const taskId = kestraTaskId("t", task.id);
      const request = protectedCallbackTask(ctx, taskId, derivedNodeId(ctx, task.id), kestraHumanTaskOperationKey, {
        form_id: jsonOf(task.formId),
        assignee: jsonOf(task.assignee),
        inputs: jsonOf(task.inputs),
      });
      const onResume = Object.keys(task.inputs)
        .sort()
        .map((name) => ({
          id: name,
          type: valueInputType(task.inputs[name]!),
          required: false,
        }));
      return ok([
        request,
        {
          id: kestraTaskId("c", task.id),
          type: "io.kestra.plugin.core.flow.Pause",
          onResume,
        },
      ]);
    }
  }
};

const compileRegisteredTask = (
  ctx: CompileContext,
  task: RegisteredTask,
): CompileOutcome<KestraCompiledTask[]> => {
  const definition = Object.hasOwn(flowTaskRegistry, task.type)
    ? flowTaskRegistry[task.type as FlowTaskTypeKey]
    : undefined;
  if (definition === undefined || task.version !== definition.version) return stop("unsupported_task");
  if (definition.kestra.mode === "not_compiled") return stop("unsupported_task");

  const operationKey = definition.protectedOperationKey ?? `workflow.task.${task.type}`;
  const inputs: Record<string, JsonValue> = {
    properties: jsonOf(task.properties),
  };
  if (task.allowRefusal === true) inputs.allow_refusal = true;
  return ok([
    protectedCallbackTask(
      ctx,
      kestraTaskId("t", task.id),
      derivedNodeId(ctx, task.id),
      operationKey,
      inputs,
    ),
  ]);
};

/**
 * Compiles one task and applies its published retry and timeout to the Kestra task that runs it.
 * Kestra retries only runnable tasks, so a retry on a control task is refused, never dropped.
 */
const compileTask = (ctx: CompileContext, task: FlowTask): CompileOutcome<KestraCompiledTask[]> => {
  const control = isFlowControlTask(task);
  if (control && task.retry !== undefined) return stop("unsupported_task");
  const compiled = control
    ? compileControlTask(ctx, task as ControlTask)
    : compileRegisteredTask(ctx, task as RegisteredTask);
  if (compiled.outcome === "refused" || (task.retry === undefined && task.timeout === undefined))
    return compiled;
  const ownId = kestraTaskId(control ? "c" : "t", task.id);
  return ok(
    compiled.value.map((step) =>
      step.id === ownId
        ? {
            ...step,
            ...(task.retry === undefined ? {} : { retry: renderRetry(task.retry) }),
            ...(task.timeout === undefined ? {} : { timeout: `PT${task.timeout.seconds}S` }),
          }
        : step,
    ),
  );
};

// ─── Retry, timeout and concurrency ──────────────────────────────────────────────────────────

/** Kestra's retry policy: `constant` has one interval; `exponential` grows up to its maximum. */
const renderRetry = (retry: NonNullable<FlowDefinition["retry"]>): Record<string, JsonValue> =>
  retry.backoff === "exponential"
    ? {
        type: "exponential",
        interval: `PT${retry.initialDelaySeconds}S`,
        maxInterval: `PT${retry.maximumDelaySeconds}S`,
        maxAttempts: retry.maximumAttempts,
      }
    : {
        type: "constant",
        interval: `PT${retry.initialDelaySeconds}S`,
        maxAttempts: retry.maximumAttempts,
      };

// ─── YAML rendering and the post-compilation check ───────────────────────────────────────────

const yamlScalar = (value: JsonValue): string => {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  return JSON.stringify(value);
};

/** A plain YAML mapping key, or the JSON-quoted key when builder text could change the structure. */
const plainYamlKeyPattern = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const yamlResolvedWordPattern = /^(y|yes|n|no|true|false|on|off|null)$/i;
const yamlKey = (key: string): string =>
  plainYamlKeyPattern.test(key) && !yamlResolvedWordPattern.test(key) ? key : JSON.stringify(key);

/** Renders plain JSON data as deterministic block-style YAML. */
const renderYaml = (value: JsonValue, indent: string): string => {
  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}[]`;
    return value
      .map((item) => {
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
          const entries = Object.entries(item);
          if (entries.length === 0) return `${indent}- {}`;
          return entries
            .map(([key, member], index) => {
              const prefix = index === 0 ? `${indent}- ` : `${indent}  `;
              return Array.isArray(member) || (member !== null && typeof member === "object")
                ? `${prefix}${yamlKey(key)}:\n${renderYaml(member as JsonValue, `${indent}    `)}`
                : `${prefix}${yamlKey(key)}: ${yamlScalar(member as JsonValue)}`;
            })
            .join("\n");
        }
        if (Array.isArray(item)) return `${indent}-\n${renderYaml(item, `${indent}  `)}`;
        return `${indent}- ${yamlScalar(item)}`;
      })
      .join("\n");
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return `${indent}{}`;
    return entries
      .map(([key, member]) =>
        Array.isArray(member) || (member !== null && typeof member === "object")
          ? `${indent}${yamlKey(key)}:\n${renderYaml(member as JsonValue, `${indent}  `)}`
          : `${indent}${yamlKey(key)}: ${yamlScalar(member as JsonValue)}`,
      )
      .join("\n");
  }
  return `${indent}${yamlScalar(value)}`;
};

/**
 * Refuses a compiled flow when any `{{` or `{%` appears outside the references
 * the compiler generated itself (and the raw blocks that keep builder text
 * inert). A flow failing the check is never registered.
 */
const containsOnlyGeneratedTemplateText = (
  yaml: string,
  allowedTokens: ReadonlySet<string>,
): boolean => {
  let cursor = 0;
  while (cursor < yaml.length) {
    const braces = yaml.indexOf("{{", cursor);
    const blocks = yaml.indexOf("{%", cursor);
    const next =
      braces === -1 ? blocks : blocks === -1 ? braces : Math.min(braces, blocks);
    if (next === -1) return true;
    if (yaml.startsWith("{% raw %}", next)) {
      const start = next + "{% raw %}".length;
      const end = yaml.indexOf("{% endraw %}", start);
      if (end === -1) return false;
      // Pebble also ends a raw block at spacing or whitespace-control variants such as
      // `{%endraw%}` or `{%- endraw %}`, so a raw body may hold no `{%` at all.
      if (yaml.slice(start, end).includes("{%")) return false;
      cursor = end + "{% endraw %}".length;
      continue;
    }
    const closer = yaml.startsWith("{{", next) ? "}}" : "%}";
    const close = yaml.indexOf(closer, next + 2);
    if (close === -1) return false;
    const token = yaml.slice(next, close + closer.length);
    if (!allowedTokens.has(token)) return false;
    cursor = close + closer.length;
  }
  return true;
};

// ─── Builder labels ──────────────────────────────────────────────────────────────────────────

const LABEL_PLACEHOLDER = "inert_builder_label";

/**
 * Reads the published flow's own diagnostic labels exactly as authored. Labels
 * never select or authorise a flow, so they are the one builder text the
 * compiler neutralises instead of refusing.
 */
const readBuilderLabels = (definition: unknown): Record<string, string> => {
  if (!isObject(definition)) return {};
  const labels = definition.labels;
  if (!isObject(labels)) return {};
  const read: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels))
    if (typeof value === "string") read[key] = value;
  return read;
};

/**
 * Replaces template delimiters in diagnostic label values before validation.
 * The canonical flow contract forbids delimiters in builder text, but a label
 * is not semantic: neutralising it lets the compiler emit the original text
 * inert instead of refusing the whole flow.
 */
const neutralizeLabelDelimiters = (definition: unknown): unknown => {
  if (!isObject(definition)) return definition;
  const labels = definition.labels;
  if (!isObject(labels)) return definition;
  const neutralized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(labels))
    neutralized[key] =
      typeof value === "string" && hasTemplateDelimiter(value) ? LABEL_PLACEHOLDER : value;
  return { ...definition, labels: neutralized };
};

/** Inert YAML text for one builder label; raw-wrapped only when it would be a template. */
const inertLabelText = (value: string): string =>
  hasTemplateDelimiter(value) ? `{% raw %}${value}{% endraw %}` : value;

/**
 * True when builder text can sit inside a raw block. Pebble ends a raw block at any `{% endraw %}`
 * spelling, including `{%endraw%}` and `{%- endraw %}`, so text holding `{%` cannot be made inert.
 */
const rawBreakPattern = /\{%/;
const labelIsRenderable = (value: string): boolean => !rawBreakPattern.test(value);

/** True for the retired node-and-edge workflow shape, refused explicitly, never silently dropped. */
const isLegacyWorkflowDefinition = (definition: unknown): boolean =>
  isObject(definition) &&
  !Object.hasOwn(definition, "contractVersion") &&
  Array.isArray(definition.nodes) &&
  Array.isArray(definition.edges) &&
  typeof definition.workflowId === "string";

// ─── Legacy node-and-edge workflows ──────────────────────────────────────────────────────────
//
// The seven workflows still shipped in the node-and-edge shape (#1088/#1092) keep compiling
// through the private `legacy-workflow-definition.ts` module until the last one is converted.
// This section and that module are deleted together when nothing needs them.

type LegacyDecisionTableConfig = Readonly<{ decisions: readonly Readonly<{ output: string }>[] }>;
type LegacyBoundedLoopConfig = Readonly<{ queryId: string; maximumRecords: number }>;
type LegacyDelayConfig = Readonly<{ seconds: number }>;
type LegacyWaitUntilConfig = Readonly<{ dateTimeFieldId: string }>;
type LegacyStartWorkflowConfig = Readonly<{ workflowId: string }>;
type LegacyStopConfig = Readonly<{ reasonCode: string }>;
type LegacyRequestFormConfig = Readonly<{
  pageId: string;
  responderPermissionKey: string;
  dueInSeconds: number;
  timeoutOutcome: string;
  outputs: readonly Readonly<{ key: string; type: string }>[];
}>;

type LegacyGraphOutcome =
  | Readonly<{
      outcome: "ok";
      nodeById: ReadonlyMap<string, WorkflowNode>;
      outgoing: ReadonlyMap<string, readonly WorkflowEdge[]>;
      loopBackEdges: ReadonlySet<WorkflowEdge>;
      startNodeId: string;
    }>
  | Readonly<{ outcome: "refused"; reason: KestraFlowCompilerRefusalReason }>;

const legacyRefused = (reason: KestraFlowCompilerRefusalReason): LegacyGraphOutcome => ({
  outcome: "refused",
  reason,
});

/** The outcomes each legacy routing node must publish exactly once, as publication required. */
const legacyRequiredOutcomes = (node: WorkflowNode): readonly string[] | undefined => {
  switch (node.type) {
    case "condition":
      return ["matched", "not_matched"];
    case "decision_table":
      return (node.config as LegacyDecisionTableConfig).decisions.map((decision) => decision.output);
    case "bounded_loop":
      return ["record", "completed"];
    case "request_form":
      return ["submitted", (node.config as LegacyRequestFormConfig).timeoutOutcome];
    default:
      return undefined;
  }
};

/**
 * Rejects a legacy graph that cannot compile to one exact candidate, applying the same structural
 * rules publication applied: one start, known and unique edges, complete outcome routing, full
 * reachability, and only bounded-loop cycles.
 */
const legacyValidateGraph = (definition: WorkflowDefinition): LegacyGraphOutcome => {
  const nodeById = new Map<string, WorkflowNode>();
  const taskIds = new Set<string>();
  for (const node of definition.nodes) {
    const taskId = `t_${node.nodeId.toLowerCase()}`;
    if (nodeById.has(node.nodeId) || taskIds.has(taskId)) return legacyRefused("duplicate_node_id");
    if (!(legacyWorkflowNodeTypeKeys as readonly string[]).includes(node.type))
      return legacyRefused("unsupported_node");
    nodeById.set(node.nodeId, node);
    taskIds.add(taskId);
  }

  const starts = definition.nodes.filter((node) => node.type === "start");
  if (starts.length === 0) return legacyRefused("missing_start_node");
  if (starts.length > 1) return legacyRefused("multiple_start_nodes");
  const startNodeId = starts[0]!.nodeId;

  const outgoing = new Map<string, WorkflowEdge[]>(
    definition.nodes.map((node) => [node.nodeId, []]),
  );
  const edgeKeys = new Set<string>();
  for (const edge of definition.edges) {
    if (!nodeById.has(edge.fromNodeId) || !nodeById.has(edge.toNodeId))
      return legacyRefused("unknown_edge_node");
    const edgeKey = `${edge.fromNodeId}\0${edge.toNodeId}\0${edge.outcome ?? ""}`;
    if (edgeKeys.has(edgeKey)) return legacyRefused("duplicate_edge");
    edgeKeys.add(edgeKey);
    outgoing.get(edge.fromNodeId)!.push(edge);
  }

  for (const node of definition.nodes) {
    const nodeEdges = outgoing.get(node.nodeId)!;
    if (node.type === "stop" && nodeEdges.length > 0) return legacyRefused("invalid_outcome_routing");
    const expected = legacyRequiredOutcomes(node);
    if (expected === undefined) continue;
    const actual = nodeEdges.map((edge) => edge.outcome);
    if (
      new Set(actual).size !== actual.length ||
      actual.length !== expected.length ||
      expected.some((outcome) => !actual.includes(outcome))
    )
      return legacyRefused("invalid_outcome_routing");
  }

  for (const edge of definition.edges)
    if (
      edge.fromNodeId === edge.toNodeId &&
      !(nodeById.get(edge.fromNodeId)!.type === "bounded_loop" && edge.outcome === "record")
    )
      return legacyRefused("self_edge");

  const reachable = new Set<string>([startNodeId]);
  const queue = [startNodeId];
  while (queue.length > 0)
    for (const edge of outgoing.get(queue.shift()!)!)
      if (!reachable.has(edge.toNodeId)) {
        reachable.add(edge.toNodeId);
        queue.push(edge.toNodeId);
      }
  if (reachable.size !== definition.nodes.length) return legacyRefused("unreachable_node");

  // Every cycle holds exactly one bounded loop whose `record` edge stays inside the cycle and
  // whose `completed` edge leaves it.
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
  if (unboundedCycle) return legacyRefused("graph_cycle");

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
      if (edge.toNodeId === node.nodeId && (body.has(edge.fromNodeId) || edge === recordEdge))
        loopBackEdges.add(edge);
  }

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
  if (ordered !== definition.nodes.length) return legacyRefused("graph_cycle");

  // Nesting depth counts child-workflow levels from this workflow at depth 1, as publication did.
  const children = definition.nodes.filter((node) => node.type === "start_workflow");
  if (
    children.some(
      (node) =>
        (node.config as LegacyStartWorkflowConfig).workflowId.toLowerCase() ===
        definition.workflowId.toLowerCase(),
    )
  )
    return legacyRefused("graph_cycle");
  if ((children.length > 0 ? 2 : 1) > definition.maximumNestingDepth)
    return legacyRefused("depth_exceeded");

  return { outcome: "ok", nodeById, outgoing, loopBackEdges, startNodeId };
};

type LegacyContext = {
  readonly identity: KestraFlowIdentity;
  readonly flowId: string;
  readonly childFlowRevisions: ReadonlyMap<string, number>;
  readonly allowedTemplateTokens: Set<string>;
  readonly nodes: KestraFlowNodeBinding[];
  readonly nodeById: ReadonlyMap<string, WorkflowNode>;
  readonly outgoing: ReadonlyMap<string, readonly WorkflowEdge[]>;
  readonly loopBackEdges: ReadonlySet<WorkflowEdge>;
  readonly insideLoop: boolean;
  refusal: KestraFlowCompilerRefusalReason | undefined;
};

type LegacyStep = Readonly<{ tasks: KestraCompiledTask[]; next: string | undefined }>;

const legacyForwardEdges = (ctx: LegacyContext, nodeId: string): readonly WorkflowEdge[] =>
  (ctx.outgoing.get(nodeId) ?? []).filter((edge) => !ctx.loopBackEdges.has(edge));

const legacyNext = (ctx: LegacyContext, nodeId: string): string | undefined => {
  const forward = legacyForwardEdges(ctx, nodeId);
  return forward.length === 1 ? forward[0]!.toNodeId : undefined;
};

const legacyDistances = (ctx: LegacyContext, start: string): ReadonlyMap<string, number> => {
  const distances = new Map<string, number>([[start, 0]]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const distance = distances.get(current)!;
    for (const edge of legacyForwardEdges(ctx, current))
      if (!distances.has(edge.toNodeId)) {
        distances.set(edge.toNodeId, distance + 1);
        queue.push(edge.toNodeId);
      }
  }
  return distances;
};

/** The nearest node every branch target can still reach, the point the branches merge again. */
const legacyMerge = (ctx: LegacyContext, targets: readonly string[]): string | undefined => {
  if (targets.length < 2) return undefined;
  const maps = targets.map((target) => legacyDistances(ctx, target));
  const common = [...maps[0]!.keys()].filter((id) => maps.every((map) => map.has(id)));
  let best: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const id of common) {
    const score = Math.max(...maps.map((map) => map.get(id)!));
    if (score < bestScore || (score === bestScore && (best === undefined || id < best))) {
      best = id;
      bestScore = score;
    }
  }
  return best;
};

const legacyPauseTask = (nodeId: string, durationSeconds: number): KestraCompiledTask => ({
  id: `c_${nodeId.toLowerCase()}`,
  type: "io.kestra.plugin.core.flow.Pause",
  pauseDuration: `PT${durationSeconds}S`,
});

const legacyStopTasks = (node: WorkflowNode): KestraCompiledTask[] =>
  stopTasks(node.nodeId.toLowerCase(), (node.config as LegacyStopConfig).reasonCode);

const legacyEffectTask = (ctx: LegacyContext, node: WorkflowNode): KestraCompiledTask =>
  protectedCallbackTask(
    ctx,
    `t_${node.nodeId.toLowerCase()}`,
    node.nodeId,
    `workflow.node.${node.type}`,
    { node_type: node.type, config: jsonOf(node.config) },
  );

const legacySubflowTask = (ctx: LegacyContext, node: WorkflowNode): KestraCompiledTask | undefined => {
  const child = (node.config as LegacyStartWorkflowConfig).workflowId.toLowerCase();
  const revision = ctx.childFlowRevisions.get(child);
  if (revision === undefined) {
    ctx.refusal = "unresolved_child_flow_revision";
    return undefined;
  }
  return {
    id: `c_${node.nodeId.toLowerCase()}`,
    type: "io.kestra.plugin.core.flow.Subflow",
    namespace: installationNamespace(ctx.identity),
    flowId: generatedFlowId(ctx.identity, child, revision),
    inputs: {},
    wait: true,
  };
};

const legacyWaitUntilTasks = (ctx: LegacyContext, node: WorkflowNode): KestraCompiledTask[] => {
  const evaluator = protectedCallbackTask(
    ctx,
    `e_${node.nodeId.toLowerCase()}`,
    node.nodeId,
    kestraEvaluatorOperationKey,
    { field: (node.config as LegacyWaitUntilConfig).dateTimeFieldId },
  );
  return [
    evaluator,
    {
      id: `c_${node.nodeId.toLowerCase()}`,
      type: "io.kestra.plugin.core.flow.Pause",
      pauseDuration: resultReference(ctx, `e_${node.nodeId.toLowerCase()}`),
    },
  ];
};

const legacyCompileBranch = (
  ctx: LegacyContext,
  node: WorkflowNode,
  stop: ReadonlySet<string>,
): LegacyStep => {
  const edges = ctx.outgoing.get(node.nodeId) ?? [];
  const edgeFor = (outcome: string): WorkflowEdge | undefined =>
    edges.find((edge) => edge.outcome === outcome);

  if (node.type === "condition") {
    const matched = edgeFor("matched");
    const notMatched = edgeFor("not_matched");
    if (matched === undefined || notMatched === undefined) {
      ctx.refusal = "invalid_outcome_routing";
      return { tasks: [], next: undefined };
    }
    const merge = legacyMerge(ctx, [matched.toNodeId, notMatched.toNodeId]);
    const branchStop = new Set(stop);
    if (merge !== undefined) branchStop.add(merge);
    const evaluator = protectedCallbackTask(
      ctx,
      `e_${node.nodeId.toLowerCase()}`,
      node.nodeId,
      kestraEvaluatorOperationKey,
      { condition: jsonOf((node.config as { condition: unknown }).condition) },
    );
    const reference = resultReference(ctx, `e_${node.nodeId.toLowerCase()}`);
    const then = compileLegacyLinear(ctx, matched.toNodeId, branchStop).tasks;
    const otherwise = compileLegacyLinear(ctx, notMatched.toNodeId, branchStop).tasks;
    return {
      tasks: [
        evaluator,
        {
          id: `c_${node.nodeId.toLowerCase()}`,
          type: "io.kestra.plugin.core.flow.If",
          condition: reference,
          then,
          ...(otherwise.length === 0 ? {} : { else: otherwise }),
        },
      ],
      next: merge,
    };
  }

  if (node.type === "decision_table") {
    const decisions = (node.config as LegacyDecisionTableConfig).decisions;
    const targets = decisions.map((decision) => edgeFor(decision.output)?.toNodeId);
    if (targets.some((target) => target === undefined)) {
      ctx.refusal = "invalid_outcome_routing";
      return { tasks: [], next: undefined };
    }
    const merge = legacyMerge(ctx, targets as string[]);
    const branchStop = new Set(stop);
    if (merge !== undefined) branchStop.add(merge);
    const cases: Record<string, JsonValue> = {};
    for (const [index, decision] of decisions.entries()) {
      const compiled = compileLegacyLinear(ctx, targets[index]!, branchStop).tasks;
      cases[decision.output] = compiled as unknown as JsonValue;
    }
    const evaluator = protectedCallbackTask(
      ctx,
      `e_${node.nodeId.toLowerCase()}`,
      node.nodeId,
      kestraEvaluatorOperationKey,
      { decisions: jsonOf(decisions) },
    );
    const reference = resultReference(ctx, `e_${node.nodeId.toLowerCase()}`);
    return {
      tasks: [
        evaluator,
        {
          id: `c_${node.nodeId.toLowerCase()}`,
          type: "io.kestra.plugin.core.flow.Switch",
          value: reference,
          cases: Object.fromEntries(
            Object.entries(cases).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
          ),
        },
      ],
      next: merge,
    };
  }

  if (node.type === "bounded_loop") {
    const record = edgeFor("record");
    const completed = edgeFor("completed");
    if (record === undefined || completed === undefined) {
      ctx.refusal = "invalid_outcome_routing";
      return { tasks: [], next: undefined };
    }
    const bodyStop = new Set(stop);
    bodyStop.add(node.nodeId);
    const bodyCtx: LegacyContext = { ...ctx, insideLoop: true };
    const body = compileLegacyLinear(bodyCtx, record.toNodeId, bodyStop).tasks;
    if (bodyCtx.refusal !== undefined) ctx.refusal = bodyCtx.refusal;
    const config = node.config as LegacyBoundedLoopConfig;
    const evaluator = protectedCallbackTask(
      ctx,
      `e_${node.nodeId.toLowerCase()}`,
      node.nodeId,
      kestraEvaluatorOperationKey,
      { query_id: config.queryId, maximum_records: config.maximumRecords },
    );
    const reference = resultReference(ctx, `e_${node.nodeId.toLowerCase()}`);
    return {
      tasks: [
        evaluator,
        {
          id: `c_${node.nodeId.toLowerCase()}`,
          type: "io.kestra.plugin.core.flow.ForEach",
          values: reference,
          tasks: body,
        },
      ],
      next: completed.toNodeId,
    };
  }

  // request_form: create the person's task through the callback, pause with typed answers, then
  // branch on the evaluator's submitted/timeout result.
  const submitted = edgeFor("submitted");
  const config = node.config as LegacyRequestFormConfig;
  const timedOut = edgeFor(config.timeoutOutcome);
  if (submitted === undefined || timedOut === undefined) {
    ctx.refusal = "invalid_outcome_routing";
    return { tasks: [], next: undefined };
  }
  const merge = legacyMerge(ctx, [submitted.toNodeId, timedOut.toNodeId]);
  const branchStop = new Set(stop);
  if (merge !== undefined) branchStop.add(merge);
  const request = protectedCallbackTask(
    ctx,
    `t_${node.nodeId.toLowerCase()}`,
    node.nodeId,
    kestraHumanTaskOperationKey,
    {
      form_id: config.pageId,
      responder_permission_key: config.responderPermissionKey,
      due_in_seconds: config.dueInSeconds,
      outputs: jsonOf(config.outputs),
    },
  );
  const outcomeNodeId = deriveNodeId(ctx.identity, ctx.flowId, `${node.nodeId}__outcome`);
  const outcome = protectedCallbackTask(
    ctx,
    `e_${node.nodeId.toLowerCase()}__outcome`,
    outcomeNodeId,
    kestraEvaluatorOperationKey,
    { form_id: config.pageId, timeout_outcome: config.timeoutOutcome },
  );
  const reference = resultReference(ctx, `e_${node.nodeId.toLowerCase()}__outcome`);
  const submittedTasks = compileLegacyLinear(ctx, submitted.toNodeId, branchStop).tasks;
  const timedOutTasks = compileLegacyLinear(ctx, timedOut.toNodeId, branchStop).tasks;
  const onResume = config.outputs
    .map((output) => ({ id: output.key, type: kestraInputType(output.type), required: false }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return {
    tasks: [
      request,
      { id: `p_${node.nodeId.toLowerCase()}`, type: "io.kestra.plugin.core.flow.Pause", onResume },
      outcome,
      {
        id: `c_${node.nodeId.toLowerCase()}`,
        type: "io.kestra.plugin.core.flow.If",
        condition: reference,
        then: submittedTasks,
        ...(timedOutTasks.length === 0 ? {} : { else: timedOutTasks }),
      },
    ],
    next: merge,
  };
};

const compileLegacyLinear = (
  ctx: LegacyContext,
  startId: string,
  stop: ReadonlySet<string>,
): LegacyStep => {
  const tasks: KestraCompiledTask[] = [];
  let current: string | undefined = startId;
  const guard = new Set<string>();
  while (current !== undefined && !stop.has(current) && !ctx.refusal) {
    if (guard.has(current)) break;
    guard.add(current);
    const node = ctx.nodeById.get(current);
    if (node === undefined) break;
    if (node.type === "start") {
      // The published start node is structural: it produces no Kestra task.
    } else if (
      node.type === "condition" ||
      node.type === "decision_table" ||
      node.type === "bounded_loop" ||
      node.type === "request_form"
    ) {
      const branch = legacyCompileBranch(ctx, node, stop);
      tasks.push(...branch.tasks);
      current = branch.next;
      continue;
    } else if (node.type === "stop") {
      tasks.push(...legacyStopTasks(node));
      return { tasks, next: undefined };
    } else if (node.type === "delay") {
      tasks.push(legacyPauseTask(node.nodeId, (node.config as LegacyDelayConfig).seconds));
    } else if (node.type === "wait_until") {
      tasks.push(...legacyWaitUntilTasks(ctx, node));
    } else if (node.type === "start_workflow") {
      const subflow = legacySubflowTask(ctx, node);
      if (subflow !== undefined) tasks.push(subflow);
    } else {
      tasks.push(legacyEffectTask(ctx, node));
    }
    current = legacyNext(ctx, current);
  }
  return { tasks, next: current !== undefined && stop.has(current) ? current : undefined };
};

const legacyTriggerSummary = (
  identity: KestraFlowIdentity,
  workflowId: string,
  trigger: WorkflowTrigger,
): Readonly<{ summary: KestraFlowTrigger; yaml: Record<string, JsonValue> | undefined }> | undefined => {
  if (trigger.condition !== null) return undefined;
  if (trigger.kind === "schedule" && !scheduleIsExpressible(trigger.schedule)) return undefined;
  if (trigger.kind === "schedule")
    return {
      summary: { id: "trigger_schedule", kind: "schedule", disabled: true, trigger: null },
      yaml: {
        id: "trigger_schedule",
        type: "io.kestra.plugin.core.trigger.Schedule",
        cron: scheduleCron(trigger.schedule),
        timezone: trigger.schedule.timeZone,
        disabled: true,
      },
    };
  if (trigger.kind === "incoming_message")
    return {
      summary: { id: "trigger_incoming_message", kind: "incoming_message", disabled: true, trigger: null },
      yaml: {
        id: "trigger_incoming_message",
        type: "io.kestra.plugin.core.trigger.Webhook",
        key: webhookKey(identity, workflowId, trigger.messageKey),
        disabled: true,
      },
    };
  // Event, button, interface and workflow starts are dispatched by Vortex, never a Kestra trigger.
  return {
    summary: { id: `trigger_${trigger.kind}`, kind: trigger.kind, disabled: true, trigger: null },
    yaml: undefined,
  };
};

const compileLegacyKestraFlow = (
  identity: KestraFlowIdentity,
  definition: WorkflowDefinition,
  childFlowRevisions: ReadonlyMap<string, number>,
): KestraFlowCompilation => {
  const graph = legacyValidateGraph(definition);
  if (graph.outcome === "refused") return refused(graph.reason);

  const ctx: LegacyContext = {
    identity,
    flowId: definition.workflowId,
    childFlowRevisions,
    allowedTemplateTokens: new Set<string>(),
    nodes: [],
    nodeById: graph.nodeById,
    outgoing: graph.outgoing,
    loopBackEdges: graph.loopBackEdges,
    insideLoop: false,
    refusal: undefined,
  };

  const compiled = compileLegacyLinear(ctx, graph.startNodeId, new Set<string>());
  if (ctx.refusal !== undefined) return refused(ctx.refusal);

  const namespace = installationNamespace(identity);
  const id = generatedFlowId(identity, definition.workflowId, identity.workflowRevision);
  if (namespace.length > maximumNamespaceLength || id.length > maximumFlowIdLength)
    return refused("invalid_identity");

  const trigger = legacyTriggerSummary(identity, definition.workflowId, definition.trigger);
  if (trigger === undefined) return refused("unsupported_trigger");
  const fixedLabels: Record<string, string> = {
    vortex_environment: identity.environment,
    vortex_organization_id: identity.organizationId,
    vortex_application_root_id: identity.applicationRootId,
    vortex_application_version: identity.applicationVersion,
    vortex_installation_revision: String(identity.installationRevision),
    vortex_workflow_id: definition.workflowId,
    vortex_workflow_key: definition.key,
    vortex_workflow_revision: String(identity.workflowRevision),
  };
  const yamlLabels: Record<string, JsonValue> = {};
  for (const key of Object.keys(fixedLabels).sort()) yamlLabels[key] = fixedLabels[key]!;

  const flowData: Record<string, JsonValue> = {
    id,
    namespace,
    labels: yamlLabels,
    tasks: compiled.tasks as unknown as JsonValue,
    ...(trigger.yaml === undefined ? {} : { triggers: [trigger.yaml] }),
  };

  const yaml = renderYaml(flowData as unknown as JsonValue, "");
  if (!containsOnlyGeneratedTemplateText(yaml, ctx.allowedTemplateTokens))
    return refused("template_text");

  const candidate: KestraFlowCandidate = Object.freeze({
    namespace,
    id,
    workflowRevision: identity.workflowRevision,
    active: false,
    trigger: Object.freeze(trigger.summary),
    triggers: Object.freeze(trigger.yaml === undefined ? [] : [trigger.summary]),
    tasks: Object.freeze(compiled.tasks),
    nodes: Object.freeze(
      [...ctx.nodes].sort((left, right) =>
        left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0,
      ),
    ),
    labels: Object.freeze(fixedLabels),
    yaml,
  });

  return { outcome: "compiled", flow: candidate };
};

// ─── Entry point ─────────────────────────────────────────────────────────────────────────────

const parseChildFlowRevisions = (candidate: unknown): ReadonlyMap<string, number> | undefined => {
  if (candidate === undefined) return new Map();
  if (!isObject(candidate)) return undefined;
  const revisions = new Map<string, number>();
  for (const [key, value] of Object.entries(candidate)) {
    const revision = revisionSchema.safeParse(value);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key.toLowerCase()))
      return undefined;
    if (!revision.success) return undefined;
    revisions.set(key.toLowerCase(), revision.data);
  }
  return revisions;
};

/**
 * Compiles one exact published durable flow and its installation identity into
 * a deterministic inactive Kestra flow candidate, or refuses with a stable
 * typed reason. The same definition and identity always yield the same
 * candidate: the namespace and flow id are derived only from permanent
 * identity, and every task, callback node and trigger comes only from the
 * published flow.
 *
 * This function is pure. It performs no I/O, signs nothing, registers nothing
 * and enables nothing, and it never invents an identity from its inputs.
 */
export const compileKestraFlow = (inputCandidate: unknown): KestraFlowCompilation => {
  if (
    !isObject(inputCandidate) ||
    !hasOnlyKeys(inputCandidate, ["definition", "identity", "childFlowRevisions"])
  )
    return refused("invalid_input");

  const identity = parseIdentity(inputCandidate.identity);
  if (identity === undefined) return refused("invalid_identity");

  const childFlowRevisions = parseChildFlowRevisions(inputCandidate.childFlowRevisions);
  if (childFlowRevisions === undefined) return refused("invalid_input");

  // Route by published shape. The retired node-and-edge form keeps compiling through the private
  // legacy module until the last shipped workflow is converted (#1088/#1092); this whole legacy
  // branch and `legacy-workflow-definition.ts` are deleted together at that point.
  if (isLegacyWorkflowDefinition(inputCandidate.definition)) {
    const legacy = legacyWorkflowDefinitionSchema.safeParse(inputCandidate.definition);
    if (!legacy.success) return refused("invalid_definition");
    if (rawBreakPattern.test(JSON.stringify(legacy.data))) return refused("unsafe_builder_text");
    return compileLegacyKestraFlow(identity, legacy.data, childFlowRevisions);
  }

  const builderLabels = readBuilderLabels(inputCandidate.definition);
  for (const value of Object.values(builderLabels))
    if (!labelIsRenderable(value)) return refused("unsafe_builder_text");
  if (rawBreakPattern.test(JSON.stringify(inputCandidate.definition) ?? ""))
    return refused("unsafe_builder_text");

  const parsedDefinition = flowSchema.safeParse(neutralizeLabelDelimiters(inputCandidate.definition));
  if (!parsedDefinition.success) return refused("invalid_definition");
  const definition = parsedDefinition.data;

  // Only durable flows run on Kestra; every other execution kind runs in Vortex.
  if (definition.execution !== "durable") return refused("not_durable");

  const namespace = installationNamespace(identity);
  const id = generatedFlowId(identity, definition.id, identity.workflowRevision);
  if (namespace.length > maximumNamespaceLength || id.length > maximumFlowIdLength)
    return refused("invalid_identity");

  const ctx: CompileContext = {
    identity,
    flow: definition,
    childFlowRevisions,
    allowedTemplateTokens: new Set<string>(),
    nodes: [],
    insideLoop: false,
  };

  const tasks = compileTaskList(ctx, definition.tasks);
  if (tasks.outcome === "refused") return refused(tasks.reason);
  const errors = compileTaskList(ctx, definition.errors);
  if (errors.outcome === "refused") return refused(errors.reason);
  const finallyTasks = compileTaskList(ctx, definition.finally);
  if (finallyTasks.outcome === "refused") return refused(finallyTasks.reason);

  // Flow outputs are computed by the Vortex evaluator through one callback each.
  const outputValues: Record<string, JsonValue> = {};
  const outputTasks: KestraCompiledTask[] = [];
  for (const name of Object.keys(definition.outputs).sort()) {
    const output = definition.outputs[name]!;
    const compiled = compileValue(ctx, `output__${name}`, output.value);
    if (compiled.outcome === "refused") return refused(compiled.reason);
    outputTasks.push(...compiled.value.tasks);
    outputValues[name] = compiled.value.expression;
  }
  const allTasks: KestraCompiledTask[] = [...tasks.value, ...outputTasks];
  if (Object.keys(outputValues).length > 0)
    allTasks.push({
      id: "flow_outputs",
      type: "io.kestra.plugin.core.output.OutputValues",
      values: outputValues,
    });

  const compiledTriggers: KestraFlowTrigger[] = [];
  const triggerYaml: JsonValue[] = [];
  for (const trigger of flowTriggers(definition)) {
    const compiled = compileTrigger(ctx, trigger);
    if (compiled.outcome === "refused") return refused(compiled.reason);
    compiledTriggers.push(compiled.value);
    triggerYaml.push(renderTriggerYaml(ctx, trigger));
  }

  const scheduled = compiledTriggers.some((trigger) => trigger.kind === "schedule");
  const triggerSummary: KestraFlowTrigger = {
    id: compiledTriggers[0]?.id ?? "trigger_none",
    kind: scheduled
      ? "schedule"
      : compiledTriggers.some((trigger) => trigger.kind === "incoming_message")
        ? "incoming_message"
        : "workflow",
    disabled: true,
    trigger: compiledTriggers[0]?.trigger ?? null,
  };

  const fixedLabels: Record<string, string> = {
    vortex_environment: identity.environment,
    vortex_organization_id: identity.organizationId,
    vortex_application_root_id: identity.applicationRootId,
    vortex_application_version: identity.applicationVersion,
    vortex_installation_revision: String(identity.installationRevision),
    vortex_workflow_id: definition.id,
    vortex_workflow_key: definition.key,
    vortex_workflow_revision: String(identity.workflowRevision),
  };
  // Builder labels never replace the identity labels the compiler derives.
  const candidateLabels: Record<string, string> = { ...builderLabels, ...fixedLabels };
  const allLabelKeys = Object.keys(candidateLabels).sort();
  const yamlLabels: Record<string, JsonValue> = {};
  for (const key of allLabelKeys) yamlLabels[key] = inertLabelText(candidateLabels[key]!);

  const flowInputs: JsonValue[] = Object.keys(definition.inputs)
    .sort()
    .map((name) => {
      const declaration = definition.inputs[name]!;
      return {
        id: name,
        type: kestraInputType(declaration.type),
        required: declaration.required,
        ...(declaration.default === undefined ? {} : { defaults: declaration.default }),
        ...(declaration.description === undefined ? {} : { description: declaration.description }),
      } as unknown as JsonValue;
    });

  const flowData: Record<string, JsonValue> = {
    id,
    namespace,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    labels: yamlLabels,
    tasks: allTasks as unknown as JsonValue,
    ...(triggerYaml.length === 0 ? {} : { triggers: triggerYaml as unknown as JsonValue }),
    ...(errors.value.length === 0 ? {} : { errors: errors.value as unknown as JsonValue }),
    ...(finallyTasks.value.length === 0
      ? {}
      : { finally: finallyTasks.value as unknown as JsonValue }),
    ...(flowInputs.length === 0 ? {} : { inputs: flowInputs }),
    ...(definition.retry === undefined ? {} : { retry: renderRetry(definition.retry) }),
    ...(definition.timeout === undefined ? {} : { timeout: `PT${definition.timeout.seconds}S` }),
    ...(definition.concurrency === undefined
      ? {}
      : {
          concurrency: {
            limit: definition.concurrency.limit,
            behavior: definition.concurrency.behavior.toUpperCase(),
          },
        }),
  };

  const yaml = renderYaml(flowData as unknown as JsonValue, "");
  if (!containsOnlyGeneratedTemplateText(yaml, ctx.allowedTemplateTokens))
    return refused("template_text");

  const flow: KestraFlowCandidate = Object.freeze({
    namespace,
    id,
    workflowRevision: identity.workflowRevision,
    active: false,
    trigger: Object.freeze(triggerSummary),
    triggers: Object.freeze(compiledTriggers),
    tasks: Object.freeze(allTasks),
    nodes: Object.freeze(
      [...ctx.nodes].sort((left, right) => (left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0)),
    ),
    labels: Object.freeze(candidateLabels),
    yaml,
  });

  return { outcome: "compiled", flow };
};
