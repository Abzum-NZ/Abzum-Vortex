import type { JsonValue } from "../catalogue/common";
import { normalizeExactDecimal, parseExactDecimal } from "../records/exact-decimal";
import type { FlowTask } from "../workflows/flow-contracts";
import type { FlowFormula } from "../workflows/flow-values";
import type { FlowRuntimeValues } from "./flow-interpreter";
import { flowRuntimeValueOf } from "./flow-runtime-value";

/**
 * The compiler cannot type a condition's literal (it never sees the compared field's value
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
