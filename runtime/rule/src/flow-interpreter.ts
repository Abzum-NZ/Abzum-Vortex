import {
  flowMaximumForEachItemsOther,
  flowMaximumProtectedOperations,
  flowMaximumRunFlowDepth,
  flowTaskRegistry,
  parseExactDecimal,
  type FlowDefinition,
  type FlowExecutionKind,
  type FlowReference,
  type FlowTask,
  type FlowValue,
  type JsonValue,
} from "@vortex/contracts";
import {
  evaluateFlowFormula,
  flowRuntimeValuesEqual,
  type FlowFormulaScope,
  type FlowRuntimeValue,
} from "./flow-formula";

/**
 * The pure interpreter of the in-house flow engine (architecture decision 1). It runs the nested
 * task list of a compiled flow as an explicit, serialisable state machine, so the same code drives
 * a flow in the server orchestrator and in the page, and a run can stop at a task it cannot run
 * itself and resume later from nothing but its state.
 *
 * It performs no effect. Control tasks and pure tasks run here. A task that needs the world stops
 * the run with a step the host must answer:
 * - `protected_task`: a read, change or background-start task. The host runs it (the server
 *   orchestrator through the one protected-operation executor) and resumes with its safe outcome.
 *   The step carries the duplicate-protection key (task path and iteration) the host uses to make
 *   the effect happen once.
 * - `interface`: a Show form or Confirm task. The run is suspended with the typed intents so far,
 *   and the page or MCP client resumes it with the person's answer.
 *
 * It never reads a clock, a record or a session: `now`, the actor and every input come from the
 * host, and nothing in a flow is evaluated as text. Every refusal is a typed failure that names its
 * code, and no failure is ever swallowed or turned into success.
 */

export const flowRunStateVersion = "1" as const;

/** The safe outcomes a failed run reports; the default error handler shows each of them. */
export type FlowFailureOutcome = "refused" | "conflict" | "validation" | "uncertain" | "failed";

/** The safe outcomes one task reports back to the interpreter. */
export type FlowTaskOutcome =
  | "completed"
  | "committed"
  | "background_pending"
  | FlowFailureOutcome;

export type FlowFailureCode =
  | "flow_unavailable"
  | "flow_not_runnable"
  | "inputs_invalid"
  | "value_unresolved"
  | "task_not_available"
  | "task_unknown"
  | "durable_only_task"
  | "for_each_limit"
  | "protected_operation_limit"
  | "run_flow_depth"
  | "step_limit"
  | "server_time_limit"
  | "output_unresolved"
  | "task_refused"
  | "resume_mismatch"
  | "continuation_unavailable";

export type FlowFailure = Readonly<{
  outcome: FlowFailureOutcome;
  code: FlowFailureCode;
  taskId?: string;
}>;

export type FlowRuntimeValues = Readonly<Record<string, FlowRuntimeValue>>;

type PathSegment = string | number;

type Frame = Readonly<{
  /** Address of the task list inside the activation's flow. */
  path: readonly PathSegment[];
  /** The next task to run in that list. */
  index: number;
  /** Present on a For each body: how many times it runs and which run this is. */
  loop?: Readonly<{ count: number; iteration: number }>;
}>;

type Phase = "tasks" | "errors" | "finally";

type Activation = Readonly<{
  flowId: string;
  /** The call chain that reached this flow, so every task path is unique within the run. */
  prefix: string;
  /** The id of the Run flow task in the parent that started this activation. */
  callTaskId?: string;
  inputs: FlowRuntimeValues;
  variables: FlowRuntimeValues;
  outputs: Readonly<Record<string, FlowRuntimeValues>>;
  phase: Phase;
  frames: readonly Frame[];
  failure?: FlowFailure;
  stopped?: string;
}>;

/** What the suspended run is waiting for, so a resume of the wrong kind is refused. */
type Awaiting =
  | Readonly<{ kind: "protected_task"; taskId: string; taskType: string; allowRefusal: boolean }>
  | Readonly<{ kind: "form"; taskId: string }>
  | Readonly<{ kind: "confirm"; taskId: string }>;

export type FlowInterfaceIntent = Readonly<{
  kind:
    | "show_message"
    | "show_form"
    | "confirm"
    | "navigate"
    | "refresh"
    | "set_panel"
    | "set_filter";
  taskId: string;
  properties: FlowRuntimeValues;
}>;

/**
 * The whole state of one run. It is plain JSON, so the host can store it server-side and bind it to
 * the run, the initiator, the organisation and the exact flow release. It holds the counters the
 * run limits need, so a resume can never start a fresh budget.
 */
export type FlowRunState = Readonly<{
  version: typeof flowRunStateVersion;
  runId: string;
  now: string;
  actor?: string;
  /**
   * The record a run acts on, keyed by field key, for `trigger.record.<field>` reads. It is set only
   * by a host that runs a flow for one record (a named action's subject) and never comes from a flow.
   */
  triggerRecord?: FlowRuntimeValues;
  activations: readonly Activation[];
  /** Protected operations started so far in this run, across every resume. */
  protectedOperations: number;
  /** Protected tasks that reported `committed`, so the host can tell a change from a no-op. */
  committedEffects: number;
  steps: number;
  /** Non-blocking intents gathered since the last suspension. */
  pendingIntents: readonly FlowInterfaceIntent[];
  awaiting?: Awaiting;
}>;

/** How the host finds a compiled flow of the exact release the run is bound to. */
export type FlowLibrary = (flowId: string) => FlowDefinition | undefined;

export type FlowProtectedTaskCall = Readonly<{
  taskId: string;
  taskType: string;
  taskVersion: string;
  effect: "read" | "change" | "background_start";
  /** The duplicate-protection key with the run id: which task, and which iteration of it. */
  taskPath: string;
  iteration: string;
  properties: FlowRuntimeValues;
  /** The running flow's own inputs, which a Call protected operation task passes by name. */
  flowInputs: FlowRuntimeValues;
  allowRefusal: boolean;
}>;

export type FlowRunResult =
  | Readonly<{
      status: "completed";
      outputs: FlowRuntimeValues;
      /** The outcome key of the Stop task that ended the flow early, when one did. */
      stopped?: string;
    }>
  | Readonly<{ status: "failed"; failure: FlowFailure }>;

export type FlowRunStep =
  | Readonly<{ kind: "protected_task"; state: FlowRunState; call: FlowProtectedTaskCall }>
  | Readonly<{
      kind: "interface";
      state: FlowRunState;
      awaiting: "form" | "confirm";
      intents: readonly FlowInterfaceIntent[];
    }>
  | Readonly<{
      kind: "finished";
      state: FlowRunState;
      intents: readonly FlowInterfaceIntent[];
      result: FlowRunResult;
    }>;

export type FlowRunStart = Readonly<{
  runId: string;
  flowId: string;
  inputs: Readonly<Record<string, unknown>>;
  now: string;
  actor?: string;
  /**
   * The execution kinds the host may start; interactive by default. A named action starts as a
   * `transaction` flow through its binding, driven by the host that owns the transaction.
   */
  executionKinds?: readonly FlowExecutionKind[];
  /** The record the run acts on, keyed by field key; see `FlowRunState.triggerRecord`. */
  triggerRecord?: FlowRuntimeValues;
  /**
   * Inputs the host has already verified and typed under its own rules (a named action checks each
   * input against its declaration before the run). When supplied they are the run's inputs as given,
   * and the interpreter's own value-shape check is not applied to them.
   */
  verifiedInputs?: FlowRuntimeValues;
}>;

export type FlowRunResume =
  | Readonly<{
      kind: "task_result";
      outcome: FlowTaskOutcome;
      outputs?: Readonly<Record<string, JsonValue>>;
    }>
  | Readonly<{ kind: "form_answered"; submitted: boolean; values: JsonValue }>
  | Readonly<{ kind: "confirmed"; confirmed: boolean }>;

const maximumSteps = 10_000;

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const nonEmptyText = (candidate: unknown): boolean =>
  typeof candidate === "string" && candidate.length > 0;

/** True when a JSON value has the shape a declared value type carries. */
const valueMatchesType = (type: string, candidate: unknown): candidate is JsonValue => {
  switch (type) {
    case "yes_no":
      return typeof candidate === "boolean";
    case "whole_number":
      return typeof candidate === "number" && Number.isSafeInteger(candidate);
    case "decimal_number":
    case "money":
      return parseExactDecimal(candidate) !== undefined;
    case "date":
      return typeof candidate === "string" && isoDate.test(candidate) &&
        Number.isFinite(Date.parse(`${candidate}T00:00:00.000Z`));
    case "date_time":
      return typeof candidate === "string" && Number.isFinite(Date.parse(candidate));
    case "text":
    case "formatted_text":
      return typeof candidate === "string";
    case "choice":
    case "record_reference":
    case "organization_account_reference":
    case "workflow_run_reference":
    case "relationship_reference":
    case "file_reference":
      return nonEmptyText(candidate);
    case "several_choices":
    case "record_reference_list":
    case "relationship_reference_list":
      return Array.isArray(candidate) && candidate.every(nonEmptyText);
    case "json":
      return candidate !== undefined;
    default:
      return false;
  }
};

const typed = (type: string, value: JsonValue): FlowRuntimeValue => ({ type, value });
const text = (value: string): FlowRuntimeValue => typed("text", value);

const clone = <Value>(input: Value): Value => JSON.parse(JSON.stringify(input)) as Value;

const pathKey = (path: readonly PathSegment[]): string => path.join("/");

const at = (root: unknown, path: readonly PathSegment[]): unknown =>
  path.reduce<unknown>(
    (current, segment) =>
      current !== null && typeof current === "object"
        ? (current as Record<PathSegment, unknown>)[segment]
        : undefined,
    root,
  );

/** The iteration key: every loop position on the call stack, or `0` outside any loop. */
const iterationKey = (state: FlowRunState): string => {
  const positions = state.activations.flatMap((activation) =>
    activation.frames.flatMap((frame) => (frame.loop === undefined ? [] : [frame.loop.iteration])),
  );
  return positions.length === 0 ? "0" : positions.join(".");
};

class Failed extends Error {
  constructor(readonly failure: FlowFailure) {
    super(failure.code);
  }
}

const failed = (code: FlowFailureCode, outcome: FlowFailureOutcome, taskId?: string): never => {
  throw new Failed({ outcome, code, ...(taskId === undefined ? {} : { taskId }) });
};

// ─── Values ───────────────────────────────────────────────────────────────────────────────────

const declaredNull = (type: string): FlowRuntimeValue => typed(type, null);

const scopeOf = (state: FlowRunState, activation: Activation, flow: FlowDefinition): FlowFormulaScope => ({
  now: state.now,
  reference: (reference: FlowReference) => {
    switch (reference.source) {
      case "input":
        return (
          activation.inputs[reference.name] ??
          (flow.inputs[reference.name] === undefined
            ? undefined
            : declaredNull(flow.inputs[reference.name]!.type))
        );
      case "variable":
        return activation.variables[reference.name];
      case "task_output":
        return activation.outputs[reference.task]?.[reference.key];
      case "execution_actor":
        return state.actor === undefined
          ? undefined
          : typed("organization_account_reference", state.actor);
      case "execution_now":
        return typed("date_time", state.now);
      // A run started by a person or a system has no trigger record, unless the host supplied the
      // record it acts on.
      case "trigger_record":
        return state.triggerRecord?.[reference.field];
      default:
        return undefined;
    }
  },
});

const evaluateValue = (
  value: FlowValue,
  state: FlowRunState,
  activation: Activation,
  flow: FlowDefinition,
  taskId: string,
): FlowRuntimeValue => {
  const scope = scopeOf(state, activation, flow);
  let result: FlowRuntimeValue | undefined;
  if (value.kind === "literal") result = typed(value.literal.type, value.literal.value);
  else if (value.kind === "reference")
    result = scope.reference(value.reference as FlowReference);
  else result = evaluateFlowFormula(value.formula, scope);
  return result ?? failed("value_unresolved", "failed", taskId);
};

const evaluateProperties = (
  properties: Readonly<Record<string, FlowValue>>,
  state: FlowRunState,
  activation: Activation,
  flow: FlowDefinition,
  taskId: string,
): FlowRuntimeValues =>
  Object.fromEntries(
    Object.entries(properties).map(([name, value]) => [
      name,
      evaluateValue(value, state, activation, flow, taskId),
    ]),
  );

// ─── Activations ──────────────────────────────────────────────────────────────────────────────

const buildInputs = (
  flow: FlowDefinition,
  supplied: Readonly<Record<string, unknown>>,
  taskId?: string,
): FlowRuntimeValues => {
  const invalid = () => failed("inputs_invalid", "validation", taskId);
  if (Object.keys(supplied).some((name) => !Object.hasOwn(flow.inputs, name))) invalid();
  const inputs: Record<string, FlowRuntimeValue> = {};
  for (const [name, declaration] of Object.entries(flow.inputs)) {
    const candidate = Object.hasOwn(supplied, name) ? supplied[name] : undefined;
    if (candidate === undefined || candidate === null) {
      if (declaration.default !== undefined) inputs[name] = typed(declaration.type, declaration.default);
      else if (declaration.required) invalid();
      continue;
    }
    if (!valueMatchesType(declaration.type, candidate)) invalid();
    inputs[name] = typed(declaration.type, candidate as JsonValue);
  }
  return inputs;
};

const initialVariables = (flow: FlowDefinition): FlowRuntimeValues =>
  Object.fromEntries(
    Object.entries(flow.variables).map(([name, declaration]) => [
      name,
      typed(declaration.type, declaration.default ?? null),
    ]),
  );

const newActivation = (
  flow: FlowDefinition,
  inputs: FlowRuntimeValues,
  prefix: string,
  callTaskId?: string,
): Activation => ({
  flowId: flow.id,
  prefix,
  ...(callTaskId === undefined ? {} : { callTaskId }),
  inputs,
  variables: initialVariables(flow),
  outputs: {},
  phase: "tasks",
  frames: [{ path: ["tasks"], index: 0 }],
});

// ─── The machine ──────────────────────────────────────────────────────────────────────────────

type Machine = {
  state: {
    -readonly [Key in keyof FlowRunState]: FlowRunState[Key];
  };
  library: FlowLibrary;
};

const topOf = (machine: Machine) => machine.state.activations[machine.state.activations.length - 1]!;

const replaceTop = (machine: Machine, next: Activation): void => {
  machine.state.activations = [...machine.state.activations.slice(0, -1), next];
};

const flowOf = (machine: Machine, activation: Activation): FlowDefinition =>
  machine.library(activation.flowId) ?? failed("flow_unavailable", "failed");

const withFrames = (activation: Activation, frames: readonly Frame[]): Activation => ({
  ...activation,
  frames,
});

const advanceFrame = (activation: Activation): Activation =>
  withFrames(activation, [
    ...activation.frames.slice(0, -1),
    { ...activation.frames[activation.frames.length - 1]!, index: activation.frames[activation.frames.length - 1]!.index + 1 },
  ]);

const pushFrame = (activation: Activation, frame: Frame): Activation =>
  withFrames(activation, [...activation.frames, frame]);

/** Records the first failure of an activation and leaves the task list. */
const failActivation = (activation: Activation, failure: FlowFailure): Activation => {
  const recorded = activation.failure ?? failure;
  return { ...activation, failure: recorded, frames: [] };
};

const stringOutcomeOutputs = (outcome: string): FlowRuntimeValues => ({ outcome: text(outcome) });

/**
 * Ends the current phase's task list and starts the next: tasks, then errors (only after a
 * failure), then finally. Returns false when every phase is done.
 */
const nextPhase = (machine: Machine, activation: Activation): Activation | undefined => {
  const flow = flowOf(machine, activation);
  const order: Phase[] = ["tasks", "errors", "finally"];
  for (const phase of order.slice(order.indexOf(activation.phase) + 1)) {
    if (phase === "errors" && activation.failure === undefined) continue;
    if (flow[phase].length === 0) continue;
    return { ...activation, phase, frames: [{ path: [phase], index: 0 }] };
  }
  return undefined;
};

const finishActivation = (machine: Machine, activation: Activation): FlowRunResult => {
  const flow = flowOf(machine, activation);
  if (activation.failure !== undefined) return { status: "failed", failure: activation.failure };
  const outputs: Record<string, FlowRuntimeValue> = {};
  for (const [name, declaration] of Object.entries(flow.outputs))
    outputs[name] = evaluateValue(declaration.value, machine.state, activation, flow, name);
  return {
    status: "completed",
    outputs,
    ...(activation.stopped === undefined ? {} : { stopped: activation.stopped }),
  };
};

const storeTaskOutputs = (
  activation: Activation,
  taskId: string,
  outputs: FlowRuntimeValues,
): Activation => ({ ...activation, outputs: { ...activation.outputs, [taskId]: outputs } });

const outputTypes = (taskType: string): Readonly<Record<string, string>> =>
  Object.fromEntries(
    (flowTaskRegistry[taskType as keyof typeof flowTaskRegistry]?.outputs ?? []).map((output) => [
      output.key,
      output.type,
    ]),
  );

const declaredOutputs = (
  taskType: string,
  produced: Readonly<Record<string, JsonValue>> | undefined,
): FlowRuntimeValues => {
  const declared = outputTypes(taskType);
  const outputs: Record<string, FlowRuntimeValue> = {};
  for (const [key, type] of Object.entries(declared)) {
    const value = produced?.[key];
    if (value === undefined || value === null) continue;
    if (valueMatchesType(type, value)) outputs[key] = typed(type, value);
  }
  return outputs;
};

const interfaceKinds = {
  "interface.show_message": "show_message",
  "interface.show_form": "show_form",
  "interface.confirm": "confirm",
  "interface.navigate": "navigate",
  "interface.refresh": "refresh",
  "interface.set_panel": "set_panel",
  "interface.set_filter": "set_filter",
} as const;

const unavailablePureTasks = new Set(["data.set_values", "data.format"]);

const branch = (
  machine: Machine,
  activation: Activation,
  taskPath: readonly PathSegment[],
  list: readonly unknown[] | undefined,
  ...key: readonly PathSegment[]
): Activation =>
  list === undefined || list.length === 0
    ? activation
    : pushFrame(activation, { path: [...taskPath, ...key], index: 0 });

type Executed =
  | Readonly<{ kind: "continue" }>
  | Readonly<{ kind: "suspend"; step: FlowRunStep }>;

/** Runs one task of the top activation. Control and pure tasks complete here. */
const execute = (machine: Machine, task: FlowTask, taskPath: readonly PathSegment[]): Executed => {
  const { state } = machine;
  const activation = topOf(machine);
  const flow = flowOf(machine, activation);
  const taskId = task.id;
  let next = advanceFrame(activation);

  switch (task.type) {
    case "if": {
      const node = task as Extract<FlowTask, { type: "if" }>;
      const condition = evaluateFlowFormula(node.condition, scopeOf(state, activation, flow));
      if (condition?.type !== "yes_no") failed("value_unresolved", "failed", taskId);
      next =
        condition!.value === true
          ? branch(machine, next, taskPath, node.then, "then")
          : branch(machine, next, taskPath, node.else, "else");
      replaceTop(machine, next);
      return { kind: "continue" };
    }
    case "switch": {
      const node = task as Extract<FlowTask, { type: "switch" }>;
      const subject = evaluateValue(node.value, state, activation, flow, taskId);
      let chosen = -1;
      node.cases.forEach((entry, index) => {
        if (chosen >= 0) return;
        const equal = flowRuntimeValuesEqual(subject, typed(entry.when.type, entry.when.value));
        if (equal === undefined) failed("value_unresolved", "failed", taskId);
        if (equal) chosen = index;
      });
      next =
        chosen >= 0
          ? branch(machine, next, taskPath, node.cases[chosen]!.tasks, "cases", chosen, "tasks")
          : branch(machine, next, taskPath, node.default, "default");
      replaceTop(machine, next);
      return { kind: "continue" };
    }
    case "sequential": {
      const node = task as Extract<FlowTask, { type: "sequential" }>;
      replaceTop(machine, branch(machine, next, taskPath, node.tasks, "tasks"));
      return { kind: "continue" };
    }
    case "for_each": {
      const node = task as Extract<FlowTask, { type: "for_each" }>;
      const items = evaluateValue(node.items, state, activation, flow, taskId);
      if (!Array.isArray(items.value)) return failed("value_unresolved", "failed", taskId);
      if (items.value.length > Math.min(node.maximumItems, flowMaximumForEachItemsOther))
        failed("for_each_limit", "failed", taskId);
      replaceTop(
        machine,
        items.value.length === 0
          ? next
          : pushFrame(next, {
              path: [...taskPath, "tasks"],
              index: 0,
              loop: { count: items.value.length, iteration: 0 },
            }),
      );
      return { kind: "continue" };
    }
    case "stop": {
      const node = task as Extract<FlowTask, { type: "stop" }>;
      replaceTop(machine, { ...activation, stopped: node.outcome, frames: [] });
      return { kind: "continue" };
    }
    case "run_flow": {
      const node = task as Extract<FlowTask, { type: "run_flow" }>;
      // The root activation plus at most the allowed number of nested calls.
      if (state.activations.length > flowMaximumRunFlowDepth) failed("run_flow_depth", "failed", taskId);
      const child = machine.library(node.flowId) ?? failed("flow_unavailable", "failed", taskId);
      if (child.execution !== "interactive") failed("flow_not_runnable", "failed", taskId);
      const supplied = Object.fromEntries(
        Object.entries(node.inputs).map(([name, value]) => [
          name,
          evaluateValue(value, state, activation, flow, taskId).value,
        ]),
      );
      const inputs = buildInputs(child, supplied, taskId);
      replaceTop(machine, next);
      machine.state.activations = [
        ...machine.state.activations,
        newActivation(child, inputs, `${activation.prefix}${pathKey(taskPath)}>`, taskId),
      ];
      return { kind: "continue" };
    }
    case "parallel":
    case "wait_until":
    case "wait_for_person":
      return failed("durable_only_task", "failed", taskId);
    default:
      break;
  }

  // A registered task.
  const registered = task as Extract<FlowTask, { properties: unknown }>;
  const definition = flowTaskRegistry[registered.type as keyof typeof flowTaskRegistry];
  if (definition === undefined) return failed("task_unknown", "failed", taskId);
  const properties = evaluateProperties(registered.properties, state, activation, flow, taskId);

  if (definition.effect === "pure") {
    if (unavailablePureTasks.has(registered.type)) failed("task_not_available", "failed", taskId);
    if (registered.type === "data.calculate") {
      if (properties.formula === undefined) return failed("value_unresolved", "failed", taskId);
      replaceTop(machine, storeTaskOutputs(next, taskId, { value: properties.formula }));
      return { kind: "continue" };
    }
    if (registered.type === "data.set_variable") {
      const name = properties.variable?.value;
      const value = properties.value;
      if (typeof name !== "string" || !Object.hasOwn(flow.variables, name) || value === undefined)
        return failed("value_unresolved", "failed", taskId);
      replaceTop(machine, {
        ...next,
        variables: { ...next.variables, [name]: value },
      });
      return { kind: "continue" };
    }
    // A transaction flow refuses its record here, as a save rule refuses a save.
    if (registered.type === "rule.refuse" && flow.execution === "transaction")
      return failed("task_refused", "refused", taskId);
    // Save rules give feedback in the browser and are authoritative in the save transaction.
    return failed("task_not_available", "failed", taskId);
  }

  if (definition.effect === "interface") {
    const kind = interfaceKinds[registered.type as keyof typeof interfaceKinds];
    if (kind === undefined) return failed("task_not_available", "failed", taskId);
    const intent: FlowInterfaceIntent = { kind, taskId, properties };
    replaceTop(machine, next);
    if (kind !== "show_form" && kind !== "confirm") {
      machine.state.pendingIntents = [...machine.state.pendingIntents, intent];
      return { kind: "continue" };
    }
    const intents = [...machine.state.pendingIntents, intent];
    machine.state.pendingIntents = [];
    machine.state.awaiting = { kind: kind === "show_form" ? "form" : "confirm", taskId };
    return {
      kind: "suspend",
      step: {
        kind: "interface",
        state: snapshot(machine),
        awaiting: kind === "show_form" ? "form" : "confirm",
        intents,
      },
    };
  }

  // A read, change or background-start task: the host runs it.
  if (machine.state.protectedOperations >= flowMaximumProtectedOperations)
    failed("protected_operation_limit", "failed", taskId);
  machine.state.protectedOperations += 1;
  const allowRefusal = registered.allowRefusal === true;
  machine.state.awaiting = { kind: "protected_task", taskId, taskType: registered.type, allowRefusal };
  replaceTop(machine, next);
  return {
    kind: "suspend",
    step: {
      kind: "protected_task",
      state: snapshot(machine),
      call: {
        taskId,
        taskType: registered.type,
        taskVersion: registered.version,
        effect: definition.effect as FlowProtectedTaskCall["effect"],
        taskPath: `${activation.prefix}${pathKey(taskPath)}`,
        iteration: iterationKey(machine.state),
        properties,
        flowInputs: activation.inputs,
        allowRefusal,
      },
    },
  };
};

const snapshot = (machine: Machine): FlowRunState => clone(machine.state) as FlowRunState;

/** Runs the machine until it needs the host or the run is finished. */
const run = (machine: Machine): FlowRunStep => {
  for (;;) {
    machine.state.steps += 1;
    if (machine.state.steps > maximumSteps) failed("step_limit", "failed");
    const activation = topOf(machine);
    const frame = activation.frames[activation.frames.length - 1];

    if (frame === undefined) {
      const following = nextPhase(machine, activation);
      if (following !== undefined) {
        replaceTop(machine, following);
        continue;
      }
      let result: FlowRunResult;
      try {
        result = finishActivation(machine, activation);
      } catch (error) {
        if (!(error instanceof Failed)) throw error;
        result = { status: "failed", failure: { ...error.failure, code: "output_unresolved" } };
      }
      if (machine.state.activations.length === 1) {
        const intents = machine.state.pendingIntents;
        machine.state.pendingIntents = [];
        delete machine.state.awaiting;
        return { kind: "finished", state: snapshot(machine), intents, result };
      }
      // Hand the child's result to the Run flow task in its parent.
      machine.state.activations = machine.state.activations.slice(0, -1);
      const parent = topOf(machine);
      const callTaskId = activation.callTaskId!;
      if (result.status === "failed")
        replaceTop(machine, failActivation(parent, { ...result.failure, taskId: callTaskId }));
      else replaceTop(machine, storeTaskOutputs(parent, callTaskId, result.outputs));
      continue;
    }

    const list = at(flowOf(machine, activation), frame.path) as readonly FlowTask[] | undefined;
    if (list === undefined || frame.index >= list.length) {
      // The list is done. A For each body starts its next iteration; everything else pops.
      if (frame.loop !== undefined && frame.loop.iteration + 1 < frame.loop.count)
        replaceTop(
          machine,
          withFrames(activation, [
            ...activation.frames.slice(0, -1),
            { ...frame, index: 0, loop: { ...frame.loop, iteration: frame.loop.iteration + 1 } },
          ]),
        );
      else replaceTop(machine, withFrames(activation, activation.frames.slice(0, -1)));
      continue;
    }

    const taskPath = [...frame.path, frame.index];
    try {
      const executed = execute(machine, list[frame.index]!, taskPath);
      if (executed.kind === "suspend") return executed.step;
    } catch (error) {
      if (!(error instanceof Failed)) throw error;
      // Leave the task list at the failure; the errors handler and finally still run.
      const current = topOf(machine);
      replaceTop(machine, failActivation(current, error.failure));
    }
  }
};

const failedStep = (machine: Machine, failure: FlowFailure): FlowRunStep => {
  const intents = machine.state.pendingIntents;
  machine.state.pendingIntents = [];
  delete machine.state.awaiting;
  return {
    kind: "finished",
    state: snapshot(machine),
    intents,
    result: { status: "failed", failure },
  };
};

const drive = (machine: Machine): FlowRunStep => {
  try {
    return run(machine);
  } catch (error) {
    if (error instanceof Failed) return failedStep(machine, error.failure);
    throw error;
  }
};

/**
 * Starts a run of one flow the host has already resolved and authorised. The inputs are the typed
 * inputs the binding supplied and are checked against the flow's declarations; the host supplies
 * the run id, the instant and the actor from its own trusted context.
 */
export const startFlowRun = (start: FlowRunStart, library: FlowLibrary): FlowRunStep => {
  const state: FlowRunState = {
    version: flowRunStateVersion,
    runId: start.runId,
    now: start.now,
    ...(start.actor === undefined ? {} : { actor: start.actor }),
    activations: [],
    protectedOperations: 0,
    committedEffects: 0,
    steps: 0,
    pendingIntents: [],
    ...(start.triggerRecord === undefined ? {} : { triggerRecord: start.triggerRecord }),
  };
  const machine: Machine = { state: { ...state }, library };
  const flow = library(start.flowId);
  if (flow === undefined) return failedStep(machine, { outcome: "failed", code: "flow_unavailable" });
  if (!(start.executionKinds ?? ["interactive"]).includes(flow.execution))
    return failedStep(machine, { outcome: "failed", code: "flow_not_runnable" });
  let inputs: FlowRuntimeValues;
  try {
    inputs = start.verifiedInputs ?? buildInputs(flow, start.inputs);
  } catch (error) {
    if (error instanceof Failed) return failedStep(machine, error.failure);
    throw error;
  }
  machine.state.activations = [newActivation(flow, inputs, "")];
  return drive(machine);
};

/**
 * Resumes a suspended run with what the host obtained: the safe outcome of the protected task it
 * ran, or the person's answer to the form or confirmation. A resume of the wrong kind is refused,
 * so a page can never answer a protected task or skip a confirmation.
 */
export const resumeFlowRun = (
  previous: FlowRunState,
  resume: FlowRunResume,
  library: FlowLibrary,
): FlowRunStep => {
  const machine: Machine = { state: clone(previous), library };
  const awaiting = machine.state.awaiting;
  const mismatch = () => failedStep(machine, { outcome: "failed", code: "resume_mismatch" });
  if (awaiting === undefined || previous.version !== flowRunStateVersion) return mismatch();
  delete machine.state.awaiting;
  const activation = topOf(machine);

  if (awaiting.kind === "protected_task") {
    if (resume.kind !== "task_result") return mismatch();
    const outputs = stringOutcomeOutputs(resume.outcome);
    const succeeded =
      resume.outcome === "completed" ||
      resume.outcome === "committed" ||
      resume.outcome === "background_pending";
    if (succeeded) {
      if (resume.outcome === "committed") machine.state.committedEffects += 1;
      replaceTop(
        machine,
        storeTaskOutputs(activation, awaiting.taskId, {
          ...declaredOutputs(awaiting.taskType, resume.outputs),
          ...outputs,
        }),
      );
      return drive(machine);
    }
    // A refused, conflict or invalid outcome is branched on only when the task allows it.
    const branchable =
      resume.outcome === "refused" ||
      resume.outcome === "conflict" ||
      resume.outcome === "validation";
    if (awaiting.allowRefusal && branchable) {
      replaceTop(machine, storeTaskOutputs(activation, awaiting.taskId, outputs));
      return drive(machine);
    }
    replaceTop(
      machine,
      failActivation(activation, {
        outcome: resume.outcome,
        code: "task_refused",
        taskId: awaiting.taskId,
      }),
    );
    return drive(machine);
  }

  if (awaiting.kind === "form") {
    if (resume.kind !== "form_answered") return mismatch();
    replaceTop(
      machine,
      storeTaskOutputs(activation, awaiting.taskId, {
        submitted: typed("yes_no", resume.submitted),
        values: typed("json", resume.submitted ? resume.values : null),
      }),
    );
    return drive(machine);
  }

  if (resume.kind !== "confirmed") return mismatch();
  replaceTop(
    machine,
    storeTaskOutputs(activation, awaiting.taskId, { confirmed: typed("yes_no", resume.confirmed) }),
  );
  return drive(machine);
};

/** A finished step for a run the host must stop itself, such as one that exhausted its server time. */
export const flowRunWithFailure = (
  state: FlowRunState,
  failure: FlowFailure,
): Extract<FlowRunStep, { kind: "finished" }> => ({
  kind: "finished",
  state,
  intents: [],
  result: { status: "failed", failure },
});
