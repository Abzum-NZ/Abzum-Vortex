import type { FlowRefusalFeedback } from "../workflows/flow-refusal-feedback";
import type { FlowExecutionKind } from "../workflows/flow-contracts";
import type { FlowRuntimeValue } from "./flow-formula";
import type { FlowInterfaceIntent } from "./flow-interpreter";

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
  | "continuation_unavailable"
  | "replay_unavailable";

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
  /** Binding input names the trusted host resolves in the page, never from a caller's claim. */
  pageResolvedInputs?: readonly string[];
  carriedValues?: Readonly<Record<string, FlowRuntimeValue>>; // Trusted values opened by the host.
}>;
