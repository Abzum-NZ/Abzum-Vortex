import { pageStepIntents } from "./flow-page-steps";
export { pageStepIntents } from "./flow-page-steps";
import { describeFailure } from "../catalogue/runtime-primitives";
import { flowValueMatchesType } from "./flow-value-shapes";
import type { JsonValue } from "../catalogue/common";
import { isRecordLinkValue } from "../records/value-predicates";
import type { FlowDefinition, FlowExecutionKind, FlowTask } from "../workflows/flow-contracts";
import { isFlowReadFieldsProjection, isFlowReadFieldsTypeMap } from "../workflows/flow-read-fields";
import { flowTaskChildLists } from "../workflows/flow-task-tree";
import type { FlowRefusalFeedback } from "../workflows/flow-refusal-feedback";
import { refusalKeepsPlatformGuidance } from "../workflows/flow-refusal-guidance";
import {
  flowTaskRegistry,
  type PageStepType,
  type ServerStepType,
} from "../workflows/flow-task-registry-data";
import type { FlowReference, FlowValue } from "../workflows/flow-values";
import type { FormContinuationAnswer } from "../workflows/form-continuation-answer";
import {
  evaluateFlowFormula,
  flowRuntimeValuesEqual,
  type FlowFormulaScope,
  type FlowRuntimeValue,
} from "./flow-formula";
import { resolveFlowValue } from "./flow-value-runtime";
import {
  flowMaximumForEachItemsOther,
  flowMaximumProtectedOperations,
  flowMaximumRunFlowDepth,
  flowMaximumTaskOutputPathDepth,
} from "../workflows/flow-limits";

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
export type FlowTaskOutcome = "completed" | "committed" | "background_pending" | FlowFailureOutcome;

export type FlowFailureCode =
  | "flow_unavailable"
  | "flow_not_runnable"
  | "inputs_invalid"
  | "value_unresolved"
  | "task_not_available"
  | "task_unknown"
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
  diagnostic?: FlowRefusalFeedback;
  /** The cause for the server log: names and types only, never a submitted value. */
  reason?: string;
  /** The authored reason, message and field of the `rule.refuse` task that refused a save. */
  ruleRefusal?: Readonly<{ reason: string; message: string; field?: string }>;
}>;

/** What a save rule task reported while a save transaction flow ran, in flow order. */
export type FlowRuleFeedback = Readonly<{
  kind: "warn" | "require";
  taskId: string;
  message: string;
  /** The permanent field identity a `rule.require` task requires. */
  field?: string;
}>;

export type FlowRuntimeValues = Readonly<Record<string, FlowRuntimeValue>>;

/** The page subject and revision the host supplied as evidence for this run. */
export type FlowSubject = Readonly<{ recordId: string; revision: number }>;

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
  | Readonly<{ kind: "form"; taskId: string; answerTypes?: Readonly<Record<string, string>> }>
  | Readonly<{ kind: "confirm"; taskId: string }>;

export type FlowInterfaceIntent = Readonly<{
  kind:
    "show_message" | "show_form" | "confirm" | "navigate" | "refresh" | "set_panel" | "set_filter";
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
  /** The date at this instant in the organisation's time zone, for date deadlines. */
  organizationLocalDate?: string;
  actor?: string;
  /** The page record and revision the person saw; protected tasks still recheck access and revision. */
  subject?: FlowSubject;
  /**
   * The record a run acts on, keyed by field key, for `trigger.record.<field>` reads. It is set only
   * by a host that runs a flow for one record (a named action's subject, or the record an
   * interactive flow's record input names, read afresh at every start and resume) and never comes
   * from a flow.
   */
  triggerRecord?: FlowRuntimeValues;
  /** The record as stored before a save, keyed by field key, for `trigger.previous.<field>` reads. */
  previousRecord?: FlowRuntimeValues;
  /** Warnings and requirements the save rule tasks reported, in the order they ran. */
  ruleFeedback?: readonly FlowRuleFeedback[];
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

/** The declarations and task lists the interpreter reads, independent of the host's full release. */
export type FlowProgram = Readonly<{
  id: string;
  execution: FlowExecutionKind;
  inputs: Readonly<
    Record<
      string,
      Pick<FlowDefinition["inputs"][string], "type" | "required" | "default" | "recordTypeIds">
    >
  >;
  variables: Readonly<
    Record<string, Pick<FlowDefinition["variables"][string], "type" | "default">>
  >;
  outputs: Readonly<Record<string, Pick<FlowDefinition["outputs"][string], "type" | "value">>>;
  triggers: readonly FlowDefinition["triggers"][number][];
  tasks: readonly FlowTask[];
  errors: readonly FlowTask[];
  finally: readonly FlowTask[];
  /** Page tasks from the whole plan, used only to resolve declared output member types. */
  declaredTasks?: readonly FlowTask[];
}>;

/** How the server finds a compiled flow of the exact release the run is bound to. */
export type FlowLibrary = (flowId: string) => FlowDefinition | undefined;
/** How an interpreter host finds the task lists and declarations it is allowed to run. */
export type FlowProgramLibrary = (flowId: string) => FlowProgram | undefined;

/** Resolve a declared server output member without exposing its task properties to the page. */
export type FlowOutputMemberTypeResolver = (
  task: FlowTask | undefined,
  taskId: string,
  outputKey: string,
  path: readonly string[],
) => string | undefined;

/** The page supplies a form field from its existing form registry and compiled field type. */
export type FlowFormReferenceResolver = (
  reference: Extract<FlowReference, { source: "form" }>,
) => FlowRuntimeValue | undefined;

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

/** Optional, read-only observation of each task the interpreter reaches. */
export type FlowTaskTraceObservation = Readonly<{
  flowId: string;
  taskId: string;
  taskType: string;
  iteration: string;
  outcome: "entered" | "completed" | "awaiting" | "interface" | "failed";
  failure?: FlowFailure;
  intent?: FlowInterfaceIntent;
}>;

/** An observer cannot change interpreter results; observer errors are ignored. */
export type FlowTaskTraceObserver = (observation: FlowTaskTraceObservation) => void;

export type FlowRunStart = Readonly<{
  runId: string;
  flowId: string;
  inputs: Readonly<Record<string, unknown>>;
  now: string;
  /** The date at this instant in the organisation's time zone, for date deadlines. */
  organizationLocalDate?: string;
  actor?: string;
  /** Page record evidence retained with the run across form and confirmation pauses. */
  subject?: FlowSubject;
  /**
   * The execution kinds the host may start; interactive by default. A named action starts as a
   * `transaction` flow through its binding, driven by the host that owns the transaction.
   */
  executionKinds?: readonly FlowExecutionKind[];
  /** The record the run acts on, keyed by field key; see `FlowRunState.triggerRecord`. */
  triggerRecord?: FlowRuntimeValues;
  /** The record as stored before a save; see `FlowRunState.previousRecord`. */
  previousRecord?: FlowRuntimeValues;
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
      diagnostic?: FlowRefusalFeedback;
    }>
  | FormContinuationAnswer;

const maximumSteps = 10_000;

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

const failed = (
  code: FlowFailureCode,
  outcome: FlowFailureOutcome,
  taskId?: string,
  reason?: string,
): never => {
  throw new Failed({
    outcome,
    code,
    ...(taskId === undefined ? {} : { taskId }),
    ...(reason === undefined ? {} : { reason }),
  });
};

// ─── Values ───────────────────────────────────────────────────────────────────────────────────

const declaredNull = (type: string): FlowRuntimeValue => typed(type, null);

const findTask = (tasks: readonly FlowTask[], taskId: string): FlowTask | undefined => {
  for (const task of tasks) {
    if (task.id === taskId) return task;
    for (const child of flowTaskChildLists(task)) {
      const found = findTask(child.tasks, taskId);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

const declaredOutputFieldType = (
  state: FlowRunState,
  activation: Activation,
  flow: FlowProgram,
  taskId: string,
  outputKey: string,
  path: readonly string[],
  resolveMember: FlowOutputMemberTypeResolver,
  resolveForm?: FlowFormReferenceResolver,
): string | undefined => {
  const task = findTask(
    flow.declaredTasks ?? [...flow.tasks, ...flow.errors, ...flow.finally],
    taskId,
  );
  const resolved = resolveMember(task, taskId, outputKey, path);
  if (resolved !== undefined) return resolved;
  if (task?.type === "record.read_fields" && path.length === 1) {
    const types = task.readFieldTypes;
    return isFlowReadFieldsTypeMap(types) && Object.hasOwn(types, path[0]!)
      ? types[path[0]!]
      : undefined;
  }
  // A show-form answer is one declared member, read as a whole (the validator refuses deeper paths).
  if (task?.type !== "interface.show_form" || path.length !== 1) return undefined;
  const inputs = (task as Extract<FlowTask, { properties: Record<string, FlowValue> }>).properties
    .inputs;
  if (inputs?.kind !== "map" || !Object.hasOwn(inputs.entries, path[0]!)) return undefined;
  return evaluateValue(
    inputs.entries[path[0]!]!,
    state,
    activation,
    flow,
    taskId,
    resolveMember,
    resolveForm,
  ).type;
};

const scopeOf = (
  state: FlowRunState,
  activation: Activation,
  flow: FlowProgram,
  resolveMember: FlowOutputMemberTypeResolver,
  resolveForm?: FlowFormReferenceResolver,
): FlowFormulaScope => ({
  now: state.now,
  ...(state.organizationLocalDate === undefined
    ? {}
    : { organizationLocalDate: state.organizationLocalDate }),
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
      case "task_output": {
        const output = activation.outputs[reference.task]?.[reference.key];
        if (output === undefined || reference.path === undefined) return output;
        if (output.type !== "json" || reference.path.length > flowMaximumTaskOutputPathDepth)
          return undefined;
        let selected: unknown = output.value;
        for (const name of reference.path) {
          if (
            selected === null ||
            typeof selected !== "object" ||
            Array.isArray(selected) ||
            !Object.hasOwn(selected, name)
          )
            return undefined;
          selected = (selected as Record<string, unknown>)[name];
        }
        const type = declaredOutputFieldType(
          state,
          activation,
          flow,
          reference.task,
          reference.key,
          reference.path,
          resolveMember,
          resolveForm,
        );
        if (type === undefined) return undefined;
        // A declared member that is present but empty (a form field left blank) is its typed null.
        if (selected === null) return declaredNull(type);
        return flowValueMatchesType(selected, type)
          ? typed(type, selected as JsonValue)
          : undefined;
      }
      case "execution_actor":
        return state.actor === undefined
          ? undefined
          : typed("organization_account_reference", state.actor);
      case "execution_now":
        return typed("date_time", state.now);
      // A run started by a person or a system has no trigger record, unless the host supplied the
      // record it acts on. That record is the started flow's own: a flow it runs reads none.
      case "trigger_record":
        return activation.prefix === "" ? state.triggerRecord?.[reference.field] : undefined;
      case "trigger_previous":
        return activation.prefix === "" ? state.previousRecord?.[reference.field] : undefined;
      case "form":
        return resolveForm?.(reference);
      default:
        return undefined;
    }
  },
});

/** The same typed reference scope used by page path guards and final output expressions. */
export const pageFlowScope = (
  state: FlowRunState,
  program: FlowProgram,
  resolveMember: FlowOutputMemberTypeResolver,
  resolveForm?: FlowFormReferenceResolver,
): FlowFormulaScope => {
  const activation = state.activations[0];
  if (
    state.version !== flowRunStateVersion ||
    state.activations.length !== 1 ||
    activation === undefined ||
    activation.flowId !== program.id
  )
    throw new Error("FLOW_PAGE_SCOPE_INVALID");
  return scopeOf(state, activation, program, resolveMember, resolveForm);
};

const evaluateValue = (
  value: FlowValue,
  state: FlowRunState,
  activation: Activation,
  flow: FlowProgram,
  taskId: string,
  resolveMember: FlowOutputMemberTypeResolver,
  resolveForm?: FlowFormReferenceResolver,
): FlowRuntimeValue => {
  return (
    resolveFlowValue(value, scopeOf(state, activation, flow, resolveMember, resolveForm)) ??
    failed("value_unresolved", "failed", taskId)
  );
};

const evaluateProperties = (
  properties: Readonly<Record<string, FlowValue>>,
  state: FlowRunState,
  activation: Activation,
  flow: FlowProgram,
  taskId: string,
  resolveMember: FlowOutputMemberTypeResolver,
  resolveForm?: FlowFormReferenceResolver,
): FlowRuntimeValues =>
  Object.fromEntries(
    Object.entries(properties).map(([name, value]) => [
      name,
      evaluateValue(value, state, activation, flow, taskId, resolveMember, resolveForm),
    ]),
  );

// ─── Activations ──────────────────────────────────────────────────────────────────────────────

const buildInputs = (
  flow: FlowProgram,
  supplied: Readonly<Record<string, unknown>>,
  taskId?: string,
): FlowRuntimeValues => {
  const invalid = (reason: string) => failed("inputs_invalid", "validation", taskId, reason);
  if (Object.keys(supplied).some((name) => !Object.hasOwn(flow.inputs, name)))
    invalid("an undeclared input was supplied");
  const inputs: Record<string, FlowRuntimeValue> = {};
  for (const [name, declaration] of Object.entries(flow.inputs)) {
    const candidate = Object.hasOwn(supplied, name) ? supplied[name] : undefined;
    if (candidate === undefined || candidate === null) {
      if (declaration.default !== undefined)
        inputs[name] = typed(declaration.type, declaration.default);
      else if (declaration.required) invalid(`required input "${name}" is missing`);
      continue;
    }
    if (!flowValueMatchesType(candidate, declaration.type))
      invalid(`input "${name}" is not a valid ${declaration.type} value`);
    inputs[name] = typed(declaration.type, candidate as JsonValue);
  }
  return inputs;
};

const initialVariables = (flow: FlowProgram): FlowRuntimeValues =>
  Object.fromEntries(
    Object.entries(flow.variables).map(([name, declaration]) => [
      name,
      typed(declaration.type, declaration.default ?? null),
    ]),
  );

const newActivation = (
  flow: FlowProgram,
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
  library: FlowProgramLibrary;
  resolveMember: FlowOutputMemberTypeResolver;
  resolveForm?: FlowFormReferenceResolver;
};

const topOf = (machine: Machine) =>
  machine.state.activations[machine.state.activations.length - 1]!;

const replaceTop = (machine: Machine, next: Activation): void => {
  machine.state.activations = [...machine.state.activations.slice(0, -1), next];
};

const flowOf = (machine: Machine, activation: Activation): FlowProgram =>
  machine.library(activation.flowId) ?? failed("flow_unavailable", "failed");

const withFrames = (activation: Activation, frames: readonly Frame[]): Activation => ({
  ...activation,
  frames,
});

const advanceFrame = (activation: Activation): Activation =>
  withFrames(activation, [
    ...activation.frames.slice(0, -1),
    {
      ...activation.frames[activation.frames.length - 1]!,
      index: activation.frames[activation.frames.length - 1]!.index + 1,
    },
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
    outputs[name] = evaluateValue(
      declaration.value,
      machine.state,
      activation,
      flow,
      name,
      machine.resolveMember,
      machine.resolveForm,
    );
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
    if (flowValueMatchesType(value, type)) outputs[key] = typed(type, value);
  }
  return outputs;
};

const validReadFieldsResume = (
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

/**
 * Which server runner executes each step that runs on the server today (`ServerStepType`): this
 * interpreter, the protected task runner (`definition/flow-task-runner.ts`), or a named action's
 * transaction flow (`rules/action-flow-run.ts`, which collects record steps into one change).
 */
export type ServerStepRunner = "interpreter" | "protected_task" | "action_flow";
export const serverStepRunners = {
  if: "interpreter",
  switch: "interpreter",
  for_each: "interpreter",
  sequential: "interpreter",
  run_flow: "interpreter",
  stop: "interpreter",
  "data.calculate": "interpreter",
  "data.record_link": "interpreter",
  "data.set_variable": "interpreter",
  "rule.require": "interpreter",
  "rule.warn": "interpreter",
  "rule.refuse": "interpreter",
  "record.save": "protected_task",
  "record.read_fields": "protected_task",
  "record.pin_identity": "protected_task",
  "operation.call": "protected_task",
  "record.create": "action_flow",
  "record.set_fields": "action_flow",
  "record.delete": "action_flow",
  "record.changes": "action_flow",
  "event.announce": "action_flow",
} as const satisfies Record<ServerStepType, ServerStepRunner>;

/** Whether the server runs this step with the given runner. */
export const serverRuns = (type: string, runner: ServerStepRunner): boolean =>
  Object.hasOwn(serverStepRunners, type) && serverStepRunners[type as ServerStepType] === runner;

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

type Executed = Readonly<{ kind: "continue" }> | Readonly<{ kind: "suspend"; step: FlowRunStep }>;

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
      const condition = evaluateFlowFormula(
        node.condition,
        scopeOf(state, activation, flow, machine.resolveMember, machine.resolveForm),
      );
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
      const subject = evaluateValue(
        node.value,
        state,
        activation,
        flow,
        taskId,
        machine.resolveMember,
        machine.resolveForm,
      );
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
      const items = evaluateValue(
        node.items,
        state,
        activation,
        flow,
        taskId,
        machine.resolveMember,
        machine.resolveForm,
      );
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
      if (state.activations.length > flowMaximumRunFlowDepth)
        failed("run_flow_depth", "failed", taskId);
      const child = machine.library(node.flowId) ?? failed("flow_unavailable", "failed", taskId);
      if (child.execution !== "interactive") failed("flow_not_runnable", "failed", taskId);
      const supplied = Object.fromEntries(
        Object.entries(node.inputs).map(([name, value]) => [
          name,
          evaluateValue(
            value,
            state,
            activation,
            flow,
            taskId,
            machine.resolveMember,
            machine.resolveForm,
          ).value,
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
    default:
      break;
  }

  // A registered task.
  const registered = task as Extract<FlowTask, { properties: unknown }>;
  const definition = flowTaskRegistry[registered.type as keyof typeof flowTaskRegistry];
  if (definition === undefined) return failed("task_unknown", "failed", taskId);
  const properties = evaluateProperties(
    registered.properties,
    state,
    activation,
    flow,
    taskId,
    machine.resolveMember,
    machine.resolveForm,
  );

  if (definition.effect === "pure") {
    if (!serverRuns(registered.type, "interpreter")) failed("task_not_available", "failed", taskId);
    if (registered.type === "data.record_link") {
      const recordType = registered.properties.record_type;
      const record = registered.properties.record;
      if (
        recordType?.kind !== "literal" ||
        recordType.literal.type !== "text" ||
        typeof recordType.literal.value !== "string" ||
        record?.kind !== "reference" ||
        record.reference.source !== "input"
      )
        return failed("value_unresolved", "failed", taskId);

      const recordTypeId = recordType.literal.value;
      const declaration = flow.inputs[record.reference.name];
      if (
        declaration === undefined ||
        declaration.type !== "record_reference" ||
        declaration.recordTypeIds?.length !== 1 ||
        declaration.recordTypeIds[0] !== recordTypeId
      )
        return failed("value_unresolved", "failed", taskId);

      const evaluatedType = properties.record_type;
      const evaluatedRecord = properties.record;
      if (
        evaluatedType?.type !== "text" ||
        evaluatedType.value !== recordTypeId ||
        evaluatedRecord?.type !== "record_reference" ||
        typeof evaluatedRecord.value !== "string"
      )
        return failed("value_unresolved", "failed", taskId);

      const link = {
        recordTypeId,
        recordId: evaluatedRecord.value,
      };
      if (!isRecordLinkValue(link)) return failed("value_unresolved", "failed", taskId);
      replaceTop(machine, storeTaskOutputs(next, taskId, { value: typed("json", link) }));
      return { kind: "continue" };
    }
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
    // A save transaction flow reports its warnings and requirements and refuses its record here.
    // Only a save reads the warnings and requirements, so any other transaction flow may only refuse.
    if (
      flow.execution === "transaction" &&
      (registered.type === "rule.refuse" ||
        (registered.type.startsWith("rule.") &&
          flow.triggers.some((trigger) => trigger.type === "BeforeSave")))
    ) {
      const message = properties.message?.value;
      if (typeof message !== "string") return failed("value_unresolved", "failed", taskId);
      const field = properties.field?.value;
      if (field !== undefined && typeof field !== "string")
        return failed("value_unresolved", "failed", taskId);
      if (registered.type === "rule.refuse") {
        const reason = properties.reason?.value;
        if (typeof reason !== "string") return failed("value_unresolved", "failed", taskId);
        throw new Failed({
          outcome: "refused",
          code: "task_refused",
          taskId,
          ruleRefusal: { reason, message, ...(field === undefined ? {} : { field }) },
        });
      }
      if (registered.type === "rule.require" && field === undefined)
        return failed("value_unresolved", "failed", taskId);
      machine.state.ruleFeedback = [
        ...(machine.state.ruleFeedback ?? []),
        {
          kind: registered.type === "rule.warn" ? "warn" : "require",
          taskId,
          message,
          ...(field === undefined ? {} : { field }),
        },
      ];
      replaceTop(machine, next);
      return { kind: "continue" };
    }
    // Save rules give feedback in the browser and are authoritative in the save transaction.
    return failed("task_not_available", "failed", taskId);
  }

  if (definition.effect === "interface") {
    const kind = Object.hasOwn(pageStepIntents, registered.type)
      ? pageStepIntents[registered.type as PageStepType]
      : undefined;
    if (kind === undefined) return failed("task_not_available", "failed", taskId);
    const intent: FlowInterfaceIntent = { kind, taskId, properties };
    replaceTop(machine, next);
    if (kind !== "show_form" && kind !== "confirm") {
      machine.state.pendingIntents = [...machine.state.pendingIntents, intent];
      return { kind: "continue" };
    }
    const intents = [...machine.state.pendingIntents, intent];
    machine.state.pendingIntents = [];
    const inputs = kind === "show_form" ? registered.properties.inputs : undefined;
    const answerTypes =
      inputs?.kind === "map"
        ? Object.fromEntries(
            Object.entries(inputs.entries).map(([name, entry]) => [
              name,
              evaluateValue(
                entry,
                state,
                activation,
                flow,
                taskId,
                machine.resolveMember,
                machine.resolveForm,
              ).type,
            ]),
          )
        : undefined;
    machine.state.awaiting =
      kind === "show_form"
        ? { kind: "form", taskId, ...(answerTypes === undefined ? {} : { answerTypes }) }
        : { kind: "confirm", taskId };
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
  machine.state.awaiting = {
    kind: "protected_task",
    taskId,
    taskType: registered.type,
    allowRefusal,
  };
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
const observe = (
  observer: FlowTaskTraceObserver | undefined,
  observation: FlowTaskTraceObservation,
): void => {
  try {
    observer?.(observation);
  } catch (error) {
    console.error(
      `[flows] trace observer failed FLOW_TRACE_OBSERVER_FAILED: ${describeFailure(error)}`,
    );
    // Diagnostics must never change a flow result.
  }
};

const run = (machine: Machine, observer?: FlowTaskTraceObserver): FlowRunStep => {
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
      const parent = machine.state.activations[machine.state.activations.length - 2]!;
      const callTaskId = activation.callTaskId!;
      observe(observer, {
        flowId: parent.flowId,
        taskId: callTaskId,
        taskType: "run_flow",
        iteration: iterationKey(machine.state),
        outcome: result.status === "failed" ? "failed" : "completed",
        ...(result.status === "failed"
          ? { failure: { ...result.failure, taskId: callTaskId } }
          : {}),
      });
      machine.state.activations = machine.state.activations.slice(0, -1);
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
    const task = list[frame.index]!;
    const observation = {
      flowId: activation.flowId,
      taskId: task.id,
      taskType: task.type,
      iteration: iterationKey(machine.state),
    } as const;
    try {
      const activationCount = machine.state.activations.length;
      const executed = execute(machine, task, taskPath);
      if (executed.kind === "suspend") {
        if (executed.step.kind === "interface") {
          const intent = executed.step.intents.find((intent) => intent.taskId === task.id);
          observe(observer, {
            ...observation,
            outcome: "interface",
            ...(intent === undefined ? {} : { intent }),
          });
        } else observe(observer, { ...observation, outcome: "awaiting" });
        return executed.step;
      }
      if (task.type === "run_flow" && machine.state.activations.length > activationCount) {
        observe(observer, { ...observation, outcome: "entered" });
      } else if (task.type.startsWith("interface.")) {
        const intent = machine.state.pendingIntents.at(-1);
        observe(observer, {
          ...observation,
          outcome: "interface",
          ...(intent?.taskId === task.id ? { intent } : {}),
        });
      } else observe(observer, { ...observation, outcome: "completed" });
    } catch (error) {
      if (!(error instanceof Failed)) throw error;
      observe(observer, { ...observation, outcome: "failed", failure: error.failure });
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

const drive = (machine: Machine, observer?: FlowTaskTraceObserver): FlowRunStep => {
  try {
    return run(machine, observer);
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
export const startFlowRun = (
  start: FlowRunStart,
  library: FlowProgramLibrary,
  resolveMember: FlowOutputMemberTypeResolver,
  observer?: FlowTaskTraceObserver,
  resolveForm?: FlowFormReferenceResolver,
): FlowRunStep => {
  const state: FlowRunState = {
    version: flowRunStateVersion,
    runId: start.runId,
    now: start.now,
    ...(start.organizationLocalDate === undefined
      ? {}
      : { organizationLocalDate: start.organizationLocalDate }),
    ...(start.actor === undefined ? {} : { actor: start.actor }),
    ...(start.subject === undefined ? {} : { subject: start.subject }),
    activations: [],
    protectedOperations: 0,
    committedEffects: 0,
    steps: 0,
    pendingIntents: [],
    ...(start.triggerRecord === undefined ? {} : { triggerRecord: start.triggerRecord }),
    ...(start.previousRecord === undefined ? {} : { previousRecord: start.previousRecord }),
  };
  const machine: Machine = {
    state: { ...state },
    library,
    resolveMember,
    ...(resolveForm === undefined ? {} : { resolveForm }),
  };
  const flow = library(start.flowId);
  if (flow === undefined)
    return failedStep(machine, { outcome: "failed", code: "flow_unavailable" });
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
  return drive(machine, observer);
};

/**
 * Starts one detached page segment, retaining the preceding segment's typed activation. The page
 * driver chooses the segment and its phase; the interpreter still executes its task tree. Final
 * outputs and the next phase are handled by the driver after all selected segments have run.
 */
export const startPageFlowSegment = (
  program: FlowProgram,
  start: FlowRunStart,
  resolveMember: FlowOutputMemberTypeResolver,
  previous?: FlowRunState,
  resolveForm?: FlowFormReferenceResolver,
): FlowRunStep => {
  const library: FlowProgramLibrary = (id) => (id === program.id ? program : undefined);
  if (
    program.execution !== "interactive" ||
    program.errors.length !== 0 ||
    program.finally.length !== 0 ||
    Object.keys(program.outputs).length !== 0
  )
    throw new Error("FLOW_PAGE_SEGMENT_PROGRAM_INVALID");
  if (previous === undefined)
    return startFlowRun(start, library, resolveMember, undefined, resolveForm);
  const machine: Machine = {
    state: clone(previous),
    library,
    resolveMember,
    ...(resolveForm === undefined ? {} : { resolveForm }),
  };
  const activation = machine.state.activations[0];
  if (
    previous.version !== flowRunStateVersion ||
    previous.runId !== start.runId ||
    previous.awaiting !== undefined ||
    previous.activations.length !== 1 ||
    activation === undefined ||
    activation.flowId !== program.id ||
    activation.frames.length !== 0
  )
    return failedStep(machine, { outcome: "failed", code: "resume_mismatch" });
  const retained: { -readonly [Key in keyof Activation]: Activation[Key] } = { ...activation };
  delete retained.failure;
  delete retained.stopped;
  machine.state.activations = [
    { ...retained, phase: "tasks", frames: [{ path: ["tasks"], index: 0 }] },
  ];
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
  library: FlowProgramLibrary,
  resolveMember: FlowOutputMemberTypeResolver,
  observer?: FlowTaskTraceObserver,
  resolveForm?: FlowFormReferenceResolver,
): FlowRunStep => {
  const machine: Machine = {
    state: clone(previous),
    library,
    resolveMember,
    ...(resolveForm === undefined ? {} : { resolveForm }),
  };
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
      if (
        awaiting.taskType === "record.read_fields" &&
        !validReadFieldsResume(machine.library(activation.flowId), awaiting.taskId, resume.outputs)
      ) {
        replaceTop(
          machine,
          failActivation(activation, {
            outcome: "validation",
            code: "output_unresolved",
            taskId: awaiting.taskId,
          }),
        );
        return drive(machine, observer);
      }
      if (resume.outcome === "committed") machine.state.committedEffects += 1;
      replaceTop(
        machine,
        storeTaskOutputs(activation, awaiting.taskId, {
          ...declaredOutputs(awaiting.taskType, resume.outputs),
          ...outputs,
        }),
      );
      return drive(machine, observer);
    }
    // A refused, conflict or invalid outcome is branched on only when the task allows it.
    const branchable =
      resume.outcome === "refused" ||
      resume.outcome === "conflict" ||
      resume.outcome === "validation";
    // Confirmed guidance (sign-in recovery, incompatible storage, a named missing installation
    // permission) is never replaced by an authored handler for ordinary refusals.
    if (
      awaiting.allowRefusal &&
      branchable &&
      !refusalKeepsPlatformGuidance(resume.diagnostic?.code)
    ) {
      replaceTop(machine, storeTaskOutputs(activation, awaiting.taskId, outputs));
      return drive(machine, observer);
    }
    replaceTop(
      machine,
      failActivation(activation, {
        outcome: resume.outcome,
        code: "task_refused",
        taskId: awaiting.taskId,
        ...(resume.diagnostic === undefined ? {} : { diagnostic: resume.diagnostic }),
      }),
    );
    return drive(machine, observer);
  }

  if (awaiting.kind === "form") {
    if (resume.kind !== "submit" && resume.kind !== "cancel") return mismatch();
    const submitted = resume.kind === "submit";
    let values: JsonValue | null = null;
    if (resume.kind === "submit") {
      values = resume.values;
    }
    if (submitted && awaiting.answerTypes !== undefined) {
      const answers =
        values !== null && typeof values === "object" && !Array.isArray(values)
          ? values
          : undefined;
      const declared = Object.entries(awaiting.answerTypes);
      const invalidAnswer =
        answers === undefined
          ? "the submitted answers are not an object"
          : Object.keys(answers).length !== declared.length
            ? "the submitted answers do not match the form's declared answers"
            : // A field left empty answers null; whether it may be empty is the form's and the
              // consuming task's decision, so only a present value must match its declared type.
              declared.find(
                ([name, type]) =>
                  !Object.hasOwn(answers, name) ||
                  (answers[name] !== null && !flowValueMatchesType(answers[name], type)),
              );
      if (invalidAnswer !== undefined) {
        replaceTop(
          machine,
          failActivation(activation, {
            outcome: "validation",
            code: "inputs_invalid",
            taskId: awaiting.taskId,
            reason:
              typeof invalidAnswer === "string"
                ? invalidAnswer
                : `answer "${invalidAnswer[0]}" is missing or not a valid ${invalidAnswer[1]} value`,
          }),
        );
        return drive(machine, observer);
      }
    }
    replaceTop(
      machine,
      storeTaskOutputs(activation, awaiting.taskId, {
        submitted: typed("yes_no", submitted),
        values: typed("json", values),
      }),
    );
    return drive(machine, observer);
  }

  if (resume.kind !== "confirm") return mismatch();
  replaceTop(
    machine,
    storeTaskOutputs(activation, awaiting.taskId, {
      confirmed: typed("yes_no", resume.confirmed),
      // The opt-in counts only with a yes; a declined confirmation never carries it.
      choice: typed("yes_no", resume.confirmed && resume.choice === true),
    }),
  );
  return drive(machine, observer);
};
