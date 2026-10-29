import type { JsonValue } from "../catalogue/common";
import type { FlowDateUnit, FlowLiteral, FlowReference, FlowRoundingMode } from "./flow-values";

export const flowRoundingModes = ["half_up", "half_even", "half_down", "up", "down", "ceiling", "floor"] as const;

type ArithmeticPrecision = { scale: number; rounding: FlowRoundingMode };
export type FlowFormula =
  | { op: "literal"; type: FlowLiteral["type"]; value: JsonValue }
  | { op: "reference"; reference: FlowReference }
  | { op: "now" }
  | {
      op: "deadline_passed";
      due: FlowFormula;
      status?: FlowFormula | undefined;
      terminalStatusValues: JsonValue[];
    }
  | { op: "record_id"; arg: FlowFormula }
  | { op: "add" | "multiply"; args: FlowFormula[] }
  | { op: "subtract" | "divide"; args: [FlowFormula, FlowFormula] }
  | ({ op: "round"; arg: FlowFormula } & ArithmeticPrecision)
  | { op: "min" | "max" | "coalesce"; args: FlowFormula[] }
  | ({ op: "percent"; args: [FlowFormula, FlowFormula] } & ArithmeticPrecision)
  | {
      op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "contains" | "starts_with" | "ends_with";
      left: FlowFormula;
      right: FlowFormula;
    }
  | { op: "is_empty" | "is_not_empty"; arg: FlowFormula }
  | { op: "in"; value: FlowFormula; options: FlowFormula[] }
  | { op: "and" | "or"; args: FlowFormula[] }
  | { op: "not"; arg: FlowFormula }
  | { op: "if"; condition: FlowFormula; then: FlowFormula; else: FlowFormula }
  | { op: "join"; parts: FlowFormula[]; separator?: string | undefined }
  | { op: "date_add"; date: FlowFormula; amount: FlowFormula; unit: FlowDateUnit }
  | { op: "date_diff"; from: FlowFormula; to: FlowFormula; unit: FlowDateUnit };


export const flowFormulaChildren = (formula: FlowFormula): readonly FlowFormula[] => {
  switch (formula.op) {
    case "literal":
    case "reference":
    case "now":
      return [];
    case "add":
    case "multiply":
    case "subtract":
    case "divide":
    case "min":
    case "max":
    case "coalesce":
    case "percent":
    case "and":
    case "or":
      return formula.args;
    case "round":
    case "record_id":
    case "is_empty":
    case "is_not_empty":
    case "not":
      return [formula.arg];
    case "in":
      return [formula.value, ...formula.options];
    case "if":
      return [formula.condition, formula.then, formula.else];
    case "join":
      return formula.parts;
    case "deadline_passed":
      return [formula.due, ...(formula.status === undefined ? [] : [formula.status])];
    case "date_add":
      return [formula.date, formula.amount];
    case "date_diff":
      return [formula.from, formula.to];
    default:
      return [formula.left, formula.right];
  }
};


/** A divide at a numeric escape must be protected by an explicit rounding operation. */
export const flowFormulaHasUnroundedDivide = (formula: FlowFormula): boolean =>
  formula.op !== "round" &&
  (formula.op === "divide" ||
    (formula.op === "if"
      ? [formula.then, formula.else]
      : flowFormulaChildren(formula)
    ).some(flowFormulaHasUnroundedDivide));
