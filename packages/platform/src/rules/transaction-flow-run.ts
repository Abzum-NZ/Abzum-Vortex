import type { FlowDefinition } from "../workflows/flow-contracts";
import type { FlowRuntimeValue } from "./flow-formula";
import {
  resumeFlowRun,
  startFlowRun,
  type FlowLibrary,
  type FlowProtectedTaskCall,
  type FlowRuntimeValues,
} from "./flow-interpreter";

/**
 * Runs a trigger-less `transaction` flow (a named action's flow) for the record it acts on and
 * collects the record steps it asks for, so the host applies every one of them in one
 * `apply_record_changes` call inside its own transaction (architecture decision "Every record task
 * calls one protected operation"). The run is the one flow interpreter: every value and every step
 * order comes from the flow, never from a second evaluator.
 *
 * Nothing here reads a record, a clock or a session. The host supplies the record the flow acts on,
 * the typed inputs it has already verified, the actor and the instant, and it alone decides what a
 * collected step means. A step is acknowledged to the interpreter as soon as it is collected, which
 * is sound because an action flow is linear: no later step reads an earlier step's output.
 */

/** What the host supplies for one run. */
export type TransactionFlowSeed = Readonly<{
  /** The record the flow runs on, keyed by field key, for `trigger.record.<field>` reads. */
  triggerRecord: FlowRuntimeValues;
  /** The flow's own inputs, verified and typed by the host, keyed by input key. */
  inputs: FlowRuntimeValues;
  /** The permanent identity of the record the flow runs on. */
  subjectRecordId: string;
  actor: string;
  now: string;
}>;

export type TransactionFlowOutcome =
  | Readonly<{
      kind: "collected";
      /** The flow input that names the record the flow runs on. */
      subjectInput: string;
      /** The record steps the flow asked for, in flow order, with their evaluated properties. */
      calls: readonly FlowProtectedTaskCall[];
    }>
  /** The run could not be started or finished: an unresolved value, an unavailable flow or step. */
  | Readonly<{ kind: "invalid"; reason: string }>;

/** Runs the flow once, on behalf of a host that owns the transaction. */
export type TransactionFlowRunner = (seed: TransactionFlowSeed) => TransactionFlowOutcome;

/** The step types an action flow may hold; anything else ends the run as invalid. */
const transactionFlowStepTypes: ReadonlySet<string> = new Set([
  "record.set_fields",
  "record.create",
  "record.changes",
  "record.delete",
  "event.announce",
]);

const invalid = (reason: string): TransactionFlowOutcome =>
  Object.freeze({ kind: "invalid", reason });

export const runTransactionFlow = (
  library: FlowLibrary,
  flowId: string,
  runId: string,
  seed: TransactionFlowSeed,
): TransactionFlowOutcome => {
  const flow: FlowDefinition | undefined = library(flowId);
  if (flow === undefined || flow.execution !== "transaction")
    return invalid(`flow ${flowId} is not an installed transaction flow`);
  const subjectInput = flow.recordInput;
  if (subjectInput === undefined)
    return invalid(`flow ${flowId} does not declare the input for its subject record`);
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
      const failure = step.result.failure;
      return invalid(
        `flow ${flowId} failed (${failure.code}) at task ${failure.taskId ?? "(none)"}`,
      );
    }
    // A form or confirmation has no person to answer it inside a transaction.
    if (step.kind !== "protected_task")
      return invalid(`flow ${flowId} asked for a person (${step.kind}) inside a transaction`);
    if (!transactionFlowStepTypes.has(step.call.taskType))
      return invalid(
        `flow ${flowId} holds task ${step.call.taskId} of type ${step.call.taskType}, which an action flow cannot run`,
      );
    calls.push(step.call);
    step = resumeFlowRun(step.state, { kind: "task_result", outcome: "committed" }, library);
  }
};
