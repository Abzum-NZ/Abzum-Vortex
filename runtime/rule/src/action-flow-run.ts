import type { FlowDefinition } from "@vortex/contracts";
import type { FlowRuntimeValue } from "./flow-formula";
import {
  resumeFlowRun,
  startFlowRun,
  type FlowLibrary,
  type FlowProtectedTaskCall,
  type FlowRuntimeValues,
} from "./flow-interpreter";

/**
 * Runs the compiled `transaction` flow of a named action (#1062) for the record it acts on and
 * collects the record changes it asks for, so the host applies every one of them in one
 * `apply_record_changes` call inside its own transaction (architecture decision "Every record task
 * calls one protected operation"). The run is the one flow interpreter: the precondition If task,
 * the refusal and every task order come from the flow, never from a second evaluator.
 *
 * Nothing here reads a record, a clock or a session. The host supplies the record it acts on, the
 * typed inputs it has already verified, the actor and the instant, and it alone decides what a
 * collected change means. A change is acknowledged to the interpreter as soon as it is collected,
 * which is sound because a compiled action flow is linear: no later task reads an earlier task's
 * output.
 */

/** The task types a compiled action flow may hold; anything else ends the run as invalid. */
export const actionFlowTaskTypes: ReadonlySet<string> = new Set([
  "record.set_fields",
  "record.create",
  "record.changes",
  "record.delete",
  "event.announce",
]);

/** What the host supplies for one action run. */
export type ActionFlowSeed = Readonly<{
  /** The record the action runs on, keyed by field key, for `trigger.record.<field>` reads. */
  triggerRecord: FlowRuntimeValues;
  /** The action's own inputs, verified and typed by the host, keyed by input key. */
  inputs: FlowRuntimeValues;
  /** Every input key the action declares; the flow's remaining input is the subject record. */
  declaredInputKeys: readonly string[];
  /** The permanent identity of the record the action runs on. */
  subjectRecordId: string;
  actor: string;
  now: string;
}>;

export type ActionFlowOutcome =
  | Readonly<{
      kind: "collected";
      /** The flow input that names the record the action runs on. */
      subjectInput: string;
      /** The record tasks the flow asked for, in flow order, with their evaluated properties. */
      calls: readonly FlowProtectedTaskCall[];
    }>
  /** The flow refused the record, as its precondition's otherwise branch does. */
  | Readonly<{ kind: "refused" }>
  /** The run could not be started or finished: an unresolved value, an unavailable flow or task. */
  | Readonly<{ kind: "invalid" }>;

/** Runs the action's flow once, on behalf of a host that owns the transaction. */
export type ActionFlowRunner = (seed: ActionFlowSeed) => ActionFlowOutcome;

const invalid: ActionFlowOutcome = Object.freeze({ kind: "invalid" });
const refused: ActionFlowOutcome = Object.freeze({ kind: "refused" });

/**
 * The action flow's subject record is the one declared input that is not one of the action's own.
 * The compiler names it `record`, or a suffixed name when the action declares an input of that
 * name, so it is found by elimination and never by name.
 */
const subjectInputOf = (flow: FlowDefinition, declared: readonly string[]): string | undefined => {
  const remaining = Object.keys(flow.inputs).filter((name) => !declared.includes(name));
  return remaining.length === 1 ? remaining[0] : undefined;
};

export const collectActionFlowTasks = (
  library: FlowLibrary,
  flowId: string,
  runId: string,
  seed: ActionFlowSeed,
): ActionFlowOutcome => {
  const flow = library(flowId);
  if (flow === undefined || flow.execution !== "transaction") return invalid;
  const subjectInput = subjectInputOf(flow, seed.declaredInputKeys);
  if (subjectInput === undefined) return invalid;
  const subject: FlowRuntimeValue = { type: "record_reference", value: seed.subjectRecordId };
  let step = startFlowRun(
    {
      runId,
      flowId,
      inputs: {},
      now: seed.now,
      actor: seed.actor,
      executionKinds: ["transaction"],
      triggerRecord: seed.triggerRecord,
      verifiedInputs: { ...seed.inputs, [subjectInput]: subject },
    },
    library,
  );
  const calls: FlowProtectedTaskCall[] = [];
  for (;;) {
    if (step.kind === "finished") {
      if (step.result.status === "completed") return { kind: "collected", subjectInput, calls };
      return step.result.failure.code === "task_refused" ? refused : invalid;
    }
    // A form or confirmation has no person to answer it inside a transaction.
    if (step.kind !== "protected_task" || !actionFlowTaskTypes.has(step.call.taskType))
      return invalid;
    calls.push(step.call);
    step = resumeFlowRun(step.state, { kind: "task_result", outcome: "committed" }, library);
  }
};
