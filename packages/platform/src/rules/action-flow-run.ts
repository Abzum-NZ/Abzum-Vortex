import { jsonValueSchema, type JsonValue } from "../catalogue/common";
import { normalizeExactDecimal, parseExactDecimal } from "../records/exact-decimal";
import { flowSchema, type FlowDefinition, type FlowTask } from "../workflows/flow-contracts";
import type { FlowFormula } from "../workflows/flow-values";
import type { FlowRuntimeValue } from "./flow-formula";
import {
  resumeFlowRun,
  startFlowRun,
  type FlowLibrary,
  type FlowProtectedTaskCall,
  type FlowRuntimeValues,
} from "./flow-interpreter";
import { isRecord } from "../catalogue/runtime-primitives";

/**
 * Runs the compiled `transaction` flow of a named action for the record it acts on and
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
  | Readonly<{ kind: "invalid"; reason: string }>;

/** Runs the action's flow once, on behalf of a host that owns the transaction. */
export type ActionFlowRunner = (seed: ActionFlowSeed) => ActionFlowOutcome;

/** The library of validated flows of one release; an invalid flow is unavailable, never trusted. */
export const flowLibraryOf = (flows: ReadonlyMap<string, unknown>): FlowLibrary => {
  const parsed = new Map<string, FlowDefinition | undefined>();
  return (flowId) => {
    if (parsed.has(flowId)) return parsed.get(flowId);
    const candidate = flows.get(flowId);
    const result = candidate === undefined ? undefined : flowSchema.safeParse(candidate);
    const flow = result?.success ? result.data : undefined;
    parsed.set(flowId, flow?.id === flowId ? flow : undefined);
    return parsed.get(flowId);
  };
};

// ─── The flow's typed view of stored values ──────────────────────────────────────────────────

const typedValue = (type: string, value: JsonValue | null): FlowRuntimeValue => ({
  type,
  value: value as JsonValue,
});

/**
 * The flow's own view of a stored field value or an action input, typed the way the flow evaluator
 * compares it: money by its amount, a link by the record it names, a person by the account. A value
 * that does not have the shape its type needs is a `json` value, which no comparison accepts, so a
 * precondition that reads it refuses the run instead of computing something it did not say.
 */
export const flowRuntimeValueOf = (type: string, value: unknown): FlowRuntimeValue => {
  const mapped = (flowType: string, accept: (candidate: unknown) => JsonValue | undefined) => {
    if (value === null || value === undefined) return typedValue(flowType, null);
    const accepted = accept(value);
    return accepted === undefined
      ? typedValue("json", jsonValueSchema.safeParse(value).success ? (value as JsonValue) : null)
      : typedValue(flowType, accepted);
  };
  const text = (candidate: unknown) => (typeof candidate === "string" ? candidate : undefined);
  switch (type) {
    case "text":
    case "long_text":
    case "email_address":
    case "phone_number":
    case "web_address":
    case "reference_number":
      return mapped("text", text);
    case "choice":
      return mapped("choice", text);
    case "whole_number":
      return mapped("whole_number", (candidate) =>
        typeof candidate === "number" && Number.isSafeInteger(candidate) ? candidate : undefined,
      );
    case "decimal_number":
      return mapped("decimal_number", (candidate) =>
        typeof candidate === "string" && parseExactDecimal(candidate) !== undefined
          ? candidate
          : undefined,
      );
    case "money":
      return mapped("money", (candidate) =>
        isRecord(candidate) &&
        typeof candidate.amount === "string" &&
        parseExactDecimal(candidate.amount) !== undefined
          ? candidate.amount
          : undefined,
      );
    case "yes_no":
      return mapped("yes_no", (candidate) =>
        typeof candidate === "boolean" ? candidate : undefined,
      );
    case "date":
      return mapped("date", text);
    case "date_time":
      return mapped("date_time", text);
    case "several_choices":
      return mapped("several_choices", (candidate) =>
        Array.isArray(candidate) && candidate.every((item) => typeof item === "string")
          ? (candidate as string[])
          : undefined,
      );
    case "link":
    case "link_to_one_of_several":
    case "record_reference":
      return mapped("record_reference", (candidate) =>
        isRecord(candidate) && typeof candidate.recordId === "string"
          ? candidate.recordId
          : undefined,
      );
    case "organization_account_reference":
      return mapped("organization_account_reference", text);
    // A calculated or total value carries whichever type its formula or source field has, so it is
    // typed by the shape it was stored with.
    case "calculation":
    case "total":
      if (isRecord(value) && typeof value.amount === "string")
        return flowRuntimeValueOf("money", value);
      if (typeof value === "number")
        return Number.isSafeInteger(value)
          ? typedValue("whole_number", value)
          : typedValue("json", null);
      if (typeof value === "string")
        return parseExactDecimal(value) === undefined
          ? typedValue("text", value)
          : typedValue("decimal_number", value);
      if (typeof value === "boolean") return typedValue("yes_no", value);
      return typedValue("json", null);
    default:
      return typedValue(
        "json",
        value !== undefined && jsonValueSchema.safeParse(value).success
          ? (value as JsonValue)
          : null,
      );
  }
};

// ─── The compiled precondition ───────────────────────────────────────────────────────────────

/**
 * The compiler cannot type a precondition's literal (it never sees the compared field's value
 * type), so it emits every one as `json`, and the flow evaluator never coerces a `json` value into
 * a comparison. Before the run, each literal that is compared with a record field or an action input
 * takes that operand's own type, and its value the shape that type carries, exactly as a value the
 * person or the record supplied would. A literal that does not fit stays `json` and the comparison
 * refuses the run.
 */
const literalAs = (type: string, value: JsonValue): JsonValue | undefined => {
  let candidate: unknown = value;
  // An authored number compared with a decimal or an amount is the exact decimal it spells.
  if ((type === "decimal_number" || type === "money") && typeof value === "number") {
    candidate = normalizeExactDecimal(String(value));
    if (candidate === undefined) return undefined;
  }
  if (type === "money" && typeof candidate === "string")
    return parseExactDecimal(candidate) === undefined ? undefined : candidate;
  const typed = flowRuntimeValueOf(type, candidate);
  return typed.type === type ? typed.value : undefined;
};

/** The typed values a flow's comparisons read, which give a compared literal its type. */
export type RetypeScope = Readonly<{
  triggerRecord: FlowRuntimeValues;
  previousRecord?: FlowRuntimeValues;
  inputs?: FlowRuntimeValues;
}>;

const typeOfOperand = (formula: FlowFormula, scope: RetypeScope): string | undefined => {
  if (formula.op !== "reference") return undefined;
  const reference = formula.reference;
  if (reference.source === "trigger_record") return scope.triggerRecord[reference.field]?.type;
  if (reference.source === "trigger_previous") return scope.previousRecord?.[reference.field]?.type;
  if (reference.source === "input") return scope.inputs?.[reference.name]?.type;
  return undefined;
};

const retypedLiteral = (candidate: FlowFormula, type: string | undefined): FlowFormula => {
  if (
    type === undefined ||
    type === "json" ||
    candidate.op !== "literal" ||
    candidate.type !== "json"
  )
    return candidate;
  const value = literalAs(type, candidate.value);
  return value === undefined
    ? candidate
    : ({ op: "literal", type, value } as unknown as FlowFormula);
};

const retypeFormula = (formula: FlowFormula, seed: RetypeScope): FlowFormula => {
  switch (formula.op) {
    case "eq":
    case "neq":
    case "lt":
    case "lte":
    case "gt":
    case "gte":
    case "contains":
    case "starts_with":
    case "ends_with":
      return {
        ...formula,
        left: retypedLiteral(retypeFormula(formula.left, seed), typeOfOperand(formula.right, seed)),
        right: retypedLiteral(
          retypeFormula(formula.right, seed),
          typeOfOperand(formula.left, seed),
        ),
      };
    case "in": {
      const type = typeOfOperand(formula.value, seed);
      return {
        ...formula,
        value: retypeFormula(formula.value, seed),
        options: formula.options.map((option) => retypedLiteral(retypeFormula(option, seed), type)),
      };
    }
    case "and":
    case "or":
      return { ...formula, args: formula.args.map((arg) => retypeFormula(arg, seed)) };
    case "not":
    case "is_empty":
    case "is_not_empty":
      return { ...formula, arg: retypeFormula(formula.arg, seed) };
    default:
      return formula;
  }
};

export const retypeTasks = (tasks: readonly FlowTask[], seed: RetypeScope): FlowTask[] =>
  tasks.map((task): FlowTask => {
    if (task.type !== "if") return task;
    const node = task as Extract<FlowTask, { type: "if" }>;
    return {
      ...node,
      condition: retypeFormula(node.condition, seed),
      then: retypeTasks(node.then, seed),
      ...(node.else === undefined ? {} : { else: retypeTasks(node.else, seed) }),
    };
  });

// ─── The run ─────────────────────────────────────────────────────────────────────────────────

const invalid = (reason: string): ActionFlowOutcome => Object.freeze({ kind: "invalid", reason });
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
  const installed = library(flowId);
  if (installed === undefined || installed.execution !== "transaction")
    return invalid(`flow ${flowId} is not an installed transaction flow`);
  const subjectInput = subjectInputOf(installed, seed.declaredInputKeys);
  if (subjectInput === undefined)
    return invalid(`flow ${flowId} does not declare exactly one input for its subject record`);
  const flow: FlowDefinition = { ...installed, tasks: retypeTasks(installed.tasks, seed) };
  const runnable: FlowLibrary = (requested) => (requested === flowId ? flow : library(requested));
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
    runnable,
  );
  const calls: FlowProtectedTaskCall[] = [];
  for (;;) {
    if (step.kind === "finished") {
      if (step.result.status === "completed") return { kind: "collected", subjectInput, calls };
      const failure = step.result.failure;
      return failure.code === "task_refused"
        ? refused
        : invalid(`flow ${flowId} failed (${failure.code}) at task ${failure.taskId ?? "(none)"}`);
    }
    // A form or confirmation has no person to answer it inside a transaction.
    if (step.kind !== "protected_task")
      return invalid(`flow ${flowId} asked for a person (${step.kind}) inside a transaction`);
    if (!actionFlowTaskTypes.has(step.call.taskType))
      return invalid(
        `flow ${flowId} holds task ${step.call.taskId} of type ${step.call.taskType}, which a named action cannot run`,
      );
    calls.push(step.call);
    step = resumeFlowRun(step.state, { kind: "task_result", outcome: "committed" }, runnable);
  }
};
