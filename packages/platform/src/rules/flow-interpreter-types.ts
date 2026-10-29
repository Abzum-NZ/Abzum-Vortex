import type { JsonValue } from "../catalogue/json-value";
import type { FlowDefinition, FlowExecutionKind, FlowTask } from "../workflows/flow-contracts";
import type { FlowRefusalFeedback } from "../workflows/flow-refusal-feedback";
import type { FlowReference } from "../workflows/flow-values";
import type { FormContinuationAnswer } from "../workflows/form-continuation-answer";
import type { FlowRuntimeValue } from "./flow-formula";
import type { flowRunStateVersion } from "./flow-interpreter-core";

/** The safe outcomes a failed run reports; the default error handler shows each of them. */
export type FlowFailureOutcome = "refused" | "conflict" | "validation" | "uncertain" | "failed";

/** The safe outcomes one task reports back to the interpreter. */
export type FlowTaskOutcome = "completed" | "committed" | "background_pending" | FlowFailureOutcome;

export type FlowFailureCode =
  | "flow_unavailable"
  | "flow_not_runnable"
  | "inputs_invalid"
  | "value_unresolved"
  | "non_integral_whole_number"
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

export type PathSegment = string | number;

export type Frame = Readonly<{
  /** Address of the task list inside the activation's flow. */
  path: readonly PathSegment[];
  /** The next task to run in that list. */
  index: number;
  /** Present on a For each body: how many times it runs and which run this is. */
  loop?: Readonly<{ count: number; iteration: number }>;
}>;

export type Phase = "tasks" | "errors" | "finally";

export type Activation = Readonly<{
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
export type Awaiting =
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
