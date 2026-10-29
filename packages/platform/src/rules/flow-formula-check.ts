import { valueTypesCompatible } from "../catalogue/catalogues";
import { flowFormulaHasUnroundedDivide } from "../workflows/flow-formula-tree";
import type { FlowFormula, FlowReference } from "../workflows/flow-values";
import { conditionValueType, operatorAcceptsOperands } from "./condition-types";

/** A location in a formula, relative to its containing definition. */
export type FlowFormulaPath = (string | number)[];

export type FlowFormulaCheckOptions = Readonly<{
  nowAllowed: boolean;
  /** A record money literal cannot carry a currency. */
  moneyLiterals?: boolean;
  reference: (reference: FlowReference, path: FlowFormulaPath) => string | undefined;
  issue: (
    path: FlowFormulaPath,
    rule: "vortex.definition.source_type_compatibility" | "vortex.definition.workflow_node_values",
    family: "invalid_value",
    message: string,
  ) => void;
}>;

const numericTypes: ReadonlySet<string> = new Set(["whole_number", "decimal_number", "money"]);
const dateTypes: ReadonlySet<string> = new Set(["date", "date_time"]);

/** Checks a formula against its reference environment and reports errors at their exact paths. */
export const checkFlowFormula = (
  formula: FlowFormula,
  options: FlowFormulaCheckOptions,
  path: FlowFormulaPath = [],
): string | undefined => {
  const add = options.issue;
  const child = (value: FlowFormula, ...segments: (string | number)[]) =>
    checkFlowFormula(value, options, [...path, ...segments]);
  const expect = (
    actual: string | undefined,
    accepted: (type: string) => boolean,
    childPath: FlowFormulaPath,
    wanted: string,
  ) => {
    if (actual === undefined || actual === "json" || accepted(actual)) return;
    add(
      childPath,
      "vortex.definition.source_type_compatibility",
      "invalid_value",
      `Expected ${wanted}, found ${actual}`,
    );
  };
  const numericArgs = (
    args: readonly FlowFormula[],
    segment: string,
    operation: "add" | "subtract" | "multiply" | "divide",
  ): string | undefined => {
    const types = args.map((arg, index) => {
      const type = child(arg, segment, index);
      expect(
        type,
        (candidate) => numericTypes.has(candidate),
        [...path, segment, index],
        "a number",
      );
      return type;
    });
    const money = types.flatMap((type, index) => (type === "money" ? [index] : []));
    if (
      ((operation === "add" || operation === "subtract") &&
        money.length > 0 &&
        money.length !== types.length) ||
      (operation === "multiply" && money.length > 1) ||
      (operation === "divide" && money.length > 0 && (money.length !== 1 || money[0] !== 0))
    ) {
      add(
        path,
        "vortex.definition.source_type_compatibility",
        "invalid_value",
        "These money operands cannot be combined",
      );
      return undefined;
    }
    return types.includes("money")
      ? "money"
      : types.some((type) => type === undefined || type === "json")
        ? undefined
        : types.includes("decimal_number")
          ? "decimal_number"
          : "whole_number";
  };
  switch (formula.op) {
    case "literal":
      if (formula.type === "money" && options.moneyLiterals === false) {
        add(
          path,
          "vortex.definition.source_type_compatibility",
          "invalid_value",
          "A money literal must carry its currency",
        );
        return undefined;
      }
      return formula.type;
    case "reference":
      return options.reference(formula.reference, [...path, "reference"]);
    case "record_id": {
      const type = child(formula.arg, "arg");
      if (type !== "json") {
        add(
          [...path, "arg"],
          "vortex.definition.source_type_compatibility",
          "invalid_value",
          `The record_id operand must have a declared JSON type, found ${type ?? "an unknown type"}`,
        );
        return undefined;
      }
      return "text";
    }
    case "deadline_passed":
      if (!options.nowAllowed)
        add(
          path,
          "vortex.definition.workflow_node_values",
          "invalid_value",
          "A deadline uses the current time",
        );
      expect(
        child(formula.due, "due"),
        (type) => dateTypes.has(type),
        [...path, "due"],
        "a date or date-time deadline",
      );
      if (formula.status !== undefined)
        expect(
          child(formula.status, "status"),
          (type) => type === "text" || type === "choice",
          [...path, "status"],
          "a status",
        );
      return "yes_no";
    case "now":
      if (!options.nowAllowed)
        add(
          path,
          "vortex.definition.workflow_node_values",
          "invalid_value",
          "The now operator is allowed only in interactive and background flows, and never in a trigger",
        );
      return "date_time";
    case "add":
    case "multiply":
    case "subtract": {
      return numericArgs(formula.args, "args", formula.op);
    }
    case "divide": {
      const type = numericArgs(formula.args, "args", formula.op);
      return type === "money" ? "money" : type === undefined ? undefined : "decimal_number";
    }
    case "round": {
      const type = child(formula.arg, "arg");
      expect(type, (candidate) => numericTypes.has(candidate), [...path, "arg"], "a number");
      return type;
    }
    case "min":
    case "max":
    case "coalesce": {
      const types = formula.args.map((arg, index) => child(arg, "args", index));
      const known = types.filter((type): type is string => type !== undefined && type !== "json");
      if (formula.op !== "coalesce")
        types.forEach((type, index) =>
          expect(
            type,
            (candidate) => numericTypes.has(candidate),
            [...path, "args", index],
            "a number",
          ),
        );
      const first = known[0];
      if (
        first !== undefined &&
        known.some(
          (type) =>
            !valueTypesCompatible(type, first, "condition") &&
            !valueTypesCompatible(first, type, "condition"),
        )
      ) {
        add(
          path,
          "vortex.definition.source_type_compatibility",
          "invalid_value",
          "All arguments must have compatible types",
        );
        return undefined;
      }
      if (types.some((type) => type === undefined || type === "json")) return undefined;
      return known.includes("decimal_number") && known.includes("whole_number")
        ? "decimal_number"
        : first;
    }
    case "percent": {
      const part = child(formula.args[0], "args", 0);
      const whole = child(formula.args[1], "args", 1);
      expect(part, (candidate) => numericTypes.has(candidate), [...path, "args", 0], "a number");
      expect(whole, (candidate) => numericTypes.has(candidate), [...path, "args", 1], "a number");
      if (part !== undefined && whole !== undefined && (part === "money") !== (whole === "money")) {
        add(
          path,
          "vortex.definition.source_type_compatibility",
          "invalid_value",
          "Percent operands must have the same units",
        );
        return undefined;
      }
      return part === undefined || whole === undefined || part === "json" || whole === "json"
        ? undefined
        : "decimal_number";
    }
    case "eq":
    case "neq":
    case "lt":
    case "lte":
    case "gt":
    case "gte":
    case "contains":
    case "starts_with":
    case "ends_with": {
      const left = child(formula.left, "left");
      const right = child(formula.right, "right");
      const leftType = conditionValueType(left);
      const rightType = conditionValueType(right);
      const operator = {
        eq: "equals",
        neq: "not_equals",
        lt: "less_than",
        lte: "less_than_or_equal",
        gt: "greater_than",
        gte: "greater_than_or_equal",
        contains: "contains",
        starts_with: "contains",
        ends_with: "contains",
      }[formula.op];
      if (
        leftType !== undefined &&
        rightType !== undefined &&
        (!operatorAcceptsOperands(
          operator,
          { source: "reference", semanticType: leftType },
          { source: "reference", semanticType: rightType },
        ) ||
          ((formula.op === "starts_with" || formula.op === "ends_with") &&
            (leftType !== "text" || rightType !== "text")))
      )
        add(
          path,
          "vortex.definition.source_type_compatibility",
          "invalid_value",
          `Cannot compare ${left} with ${right}`,
        );
      return "yes_no";
    }
    case "is_empty":
    case "is_not_empty":
      child(formula.arg, "arg");
      return "yes_no";
    case "in": {
      const value = child(formula.value, "value");
      formula.options.forEach((option, index) => {
        const type = child(option, "options", index);
        const valueType = conditionValueType(value);
        const optionType = conditionValueType(type);
        if (
          valueType !== undefined &&
          optionType !== undefined &&
          !operatorAcceptsOperands(
            "equals",
            { source: "reference", semanticType: valueType },
            { source: "reference", semanticType: optionType },
          )
        )
          add(
            [...path, "options", index],
            "vortex.definition.source_type_compatibility",
            "invalid_value",
            `An option of type ${type} cannot be compared with ${value}`,
          );
      });
      return "yes_no";
    }
    case "and":
    case "or":
      formula.args.forEach((arg, index) =>
        expect(
          child(arg, "args", index),
          (type) => type === "yes_no",
          [...path, "args", index],
          "a yes/no value",
        ),
      );
      return "yes_no";
    case "not":
      expect(
        child(formula.arg, "arg"),
        (type) => type === "yes_no",
        [...path, "arg"],
        "a yes/no value",
      );
      return "yes_no";
    case "if": {
      expect(
        child(formula.condition, "condition"),
        (type) => type === "yes_no",
        [...path, "condition"],
        "a yes/no value",
      );
      const then = child(formula.then, "then");
      const otherwise = child(formula.else, "else");
      if (then === undefined || otherwise === undefined || then === "json" || otherwise === "json")
        return undefined;
      if (then === otherwise) return then;
      if (
        (then === "whole_number" || then === "decimal_number") &&
        (otherwise === "whole_number" || otherwise === "decimal_number")
      )
        return "decimal_number";
      add(
        [...path, "else"],
        "vortex.definition.source_type_compatibility",
        "invalid_value",
        `Both results of if must have one type, found ${then} and ${otherwise}`,
      );
      return undefined;
    }
    case "join":
      formula.parts.forEach((part, index) => {
        const type = child(part, "parts", index);
        if (type !== undefined && numericTypes.has(type) && flowFormulaHasUnroundedDivide(part))
          add(
            [...path, "parts", index],
            "vortex.definition.source_type_compatibility",
            "invalid_value",
            "Round a division before converting it to text",
          );
      });
      return "text";
    case "date_add": {
      const date = child(formula.date, "date");
      expect(date, (type) => dateTypes.has(type), [...path, "date"], "a date or date and time");
      expect(
        child(formula.amount, "amount"),
        (type) => type === "whole_number",
        [...path, "amount"],
        "a whole number",
      );
      return date;
    }
    case "date_diff":
      expect(
        child(formula.from, "from"),
        (type) => dateTypes.has(type),
        [...path, "from"],
        "a date or date and time",
      );
      expect(
        child(formula.to, "to"),
        (type) => dateTypes.has(type),
        [...path, "to"],
        "a date or date and time",
      );
      return "whole_number";
  }
};
