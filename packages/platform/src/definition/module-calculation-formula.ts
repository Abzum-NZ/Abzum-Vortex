import { flowFormulaChildren, type FlowFormula } from "../workflows/flow-values";

/** Local record references are named while authored and resolved to permanent IDs by compilation. */
export const calculationFormulaDependencies = (formula: FlowFormula): string[] => {
  const found = new Set<string>();
  const visit = (node: FlowFormula): void => {
    if (node.op === "reference") {
      if (node.reference.source === "trigger_record") found.add(node.reference.field);
      if (node.reference.source === "module_field") found.add(node.reference.fieldId);
    }
    flowFormulaChildren(node).forEach(visit);
  };
  visit(formula);
  return [...found];
};

/** Resolves and validates all operators against the local record's declared field types. */
export const calculationFormulaType = (
  formula: FlowFormula,
  fieldType: (key: string) => string | undefined,
  dialect: "source" | "canonical",
): string | undefined => {
  const type = (node: FlowFormula): string | undefined =>
    calculationFormulaType(node, fieldType, dialect);
  const numeric = (value: string | undefined) =>
    value !== undefined && ["whole_number", "decimal_number", "money"].includes(value);
  const text = (value: string | undefined) =>
    value !== undefined && ["text", "choice"].includes(value);
  const date = (value: string | undefined) => value === "date" || value === "date_time";
  switch (formula.op) {
    case "literal":
      return formula.type;
    case "reference":
      return dialect === "source" && formula.reference.source === "trigger_record"
        ? fieldType(formula.reference.field)
        : dialect === "canonical" && formula.reference.source === "module_field"
          ? fieldType(formula.reference.fieldId)
          : undefined;
    case "now":
      return "date_time";
    case "record_id":
      return undefined;
    case "add":
    case "subtract":
    case "multiply":
    case "divide": {
      const types = formula.args.map(type);
      if (!types.every(numeric)) return undefined;
      const money = types.flatMap((entry, index) => (entry === "money" ? [index] : []));
      if (
        (formula.op === "add" || formula.op === "subtract") &&
        money.length > 0 &&
        money.length !== types.length
      )
        return undefined;
      if (formula.op === "multiply" && money.length > 1) return undefined;
      if (formula.op === "divide" && money.length > 0 && (money.length !== 1 || money[0] !== 0))
        return undefined;
      return money.length > 0
        ? "money"
        : types.includes("decimal_number") || formula.op === "divide" || formula.scale > 0
          ? "decimal_number"
          : "whole_number";
    }
    case "round": {
      const result = type(formula.arg);
      return numeric(result) ? result : undefined;
    }
    case "join":
      return formula.parts.every((part) => text(type(part))) ? "text" : undefined;
    case "date_add": {
      const result = type(formula.date);
      return date(result) &&
        type(formula.amount) === "whole_number" &&
        (result !== "date" || !["minutes", "hours"].includes(formula.unit))
        ? result
        : undefined;
    }
    case "date_diff":
      return date(type(formula.from)) && date(type(formula.to)) ? "whole_number" : undefined;
    case "deadline_passed":
      return date(type(formula.due)) &&
        (formula.status === undefined
          ? formula.terminalStatusValues.length === 0
          : text(type(formula.status)) &&
            formula.terminalStatusValues.every((value) => typeof value === "string"))
        ? "yes_no"
        : undefined;
    case "and":
    case "or":
      return formula.args.every((arg) => type(arg) === "yes_no") ? "yes_no" : undefined;
    case "not":
      return type(formula.arg) === "yes_no" ? "yes_no" : undefined;
    case "is_empty":
    case "is_not_empty":
      return type(formula.arg) === undefined ? undefined : "yes_no";
    case "if": {
      const then = type(formula.then),
        otherwise = type(formula.else);
      if (type(formula.condition) !== "yes_no" || then === undefined || otherwise === undefined)
        return undefined;
      if (then === otherwise) return then;
      return numeric(then) && numeric(otherwise) && then !== "money" && otherwise !== "money"
        ? "decimal_number"
        : undefined;
    }
    case "in": {
      const target = type(formula.value);
      return target !== undefined &&
        formula.options.every((option) => compatible(target, type(option)))
        ? "yes_no"
        : undefined;
    }
    default: {
      const left = type(formula.left),
        right = type(formula.right);
      if (["contains", "starts_with", "ends_with"].includes(formula.op))
        return text(left) && text(right) ? "yes_no" : undefined;
      if (!compatible(left, right)) return undefined;
      if (!["eq", "neq"].includes(formula.op) && !(numeric(left) || text(left) || date(left)))
        return undefined;
      return "yes_no";
    }
  }
};
const compatible = (left: string | undefined, right: string | undefined): boolean =>
  left !== undefined &&
  right !== undefined &&
  (left === right ||
    (["whole_number", "decimal_number"].includes(left) &&
      ["whole_number", "decimal_number"].includes(right)) ||
    (["text", "choice"].includes(left) && ["text", "choice"].includes(right)));

/** Current read-time storage support is the deadline operator over local fields. */
export const calculationReadTimeSupported = (formula: FlowFormula): boolean =>
  formula.op === "deadline_passed" &&
  formula.due.op === "reference" &&
  (formula.status === undefined || formula.status.op === "reference");
