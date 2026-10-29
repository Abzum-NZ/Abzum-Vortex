"use client";

import { useState } from "react";
import {
  checkFlowFormula,
  flowFormulaChildren,
  flowFormulaSchema,
  flowRoundingModeSchema,
  normalizeExactDecimal,
  type FlowFormula,
  type FlowReference,
  type FlowRoundingMode,
} from "@vortex/platform/schema";
import { Input } from "@vortex/ui/components/input";
import { Button } from "@vortex/ui/components/button";

export type FormulaReferenceChoice = Readonly<{
  name: string;
  label: string;
  type: string | undefined;
  reference: FlowReference;
}>;

export const formulaReferenceName = (reference: FlowReference): string => {
  switch (reference.source) {
    case "trigger_record":
      return reference.field;
    case "trigger_previous":
      return `previous.${reference.field}`;
    case "input":
      return `inputs.${reference.name}`;
    case "variable":
      return `vars.${reference.name}`;
    case "page":
      return `page.${reference.name}`;
    case "form":
      return `forms.${reference.form}.${reference.field}`;
    case "task_output":
      return `outputs.${reference.task}.${reference.key}${reference.path === undefined ? "" : `.${reference.path.join(".")}`}`;
    case "execution_actor":
      return "execution.actor";
    case "execution_now":
      return "execution.now";
    case "module_field":
      return `module.fields.${reference.fieldId}`;
  }
};

type Token = Readonly<{ kind: "name" | "number" | "string" | "symbol"; text: string }>;

const tokenize = (text: string): Token[] => {
  const tokens: Token[] = [];
  let position = 0;
  while (position < text.length) {
    const rest = text.slice(position);
    const space = /^\s+/.exec(rest)?.[0];
    if (space !== undefined) {
      position += space.length;
      continue;
    }
    const token =
      /^(?:"(?:[^"\\]|\\.)*"|\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_.]*|<=|>=|==|!=|[<>()+,*/-])/.exec(
        rest,
      )?.[0];
    if (token === undefined) throw new Error(`Unexpected character at position ${position + 1}.`);
    tokens.push({
      kind:
        token[0] === '"'
          ? "string"
          : /^\d/.test(token)
            ? "number"
            : /^[A-Za-z_]/.test(token)
              ? "name"
              : "symbol",
      text: token,
    });
    position += token.length;
  }
  return tokens;
};

const literal = (part: FlowFormula | undefined): unknown =>
  part?.op === "literal" ? part.value : undefined;

/** Parses Studio text into the same bounded tree the platform validates and executes. */
const parseFormula = (text: string, references: readonly FormulaReferenceChoice[]): FlowFormula => {
  const tokens = tokenize(text);
  let index = 0;
  const peek = () => tokens[index]?.text;
  const take = (expected: string) => {
    if (peek() !== expected) throw new Error(`Expected ${expected}.`);
    index += 1;
  };
  const expression = (minimum = 0): FlowFormula => {
    let left = primary();
    while (true) {
      const operator = peek();
      const precedence =
        operator === "==" ||
        operator === "!=" ||
        operator === "<" ||
        operator === "<=" ||
        operator === ">" ||
        operator === ">="
          ? 1
          : operator === "+" || operator === "-"
            ? 2
            : operator === "*" || operator === "/"
              ? 3
              : 0;
      if (precedence < minimum || precedence === 0) break;
      index += 1;
      const right = expression(precedence + 1);
      if (
        operator === "==" ||
        operator === "!=" ||
        operator === "<" ||
        operator === "<=" ||
        operator === ">" ||
        operator === ">="
      ) {
        const op =
          operator === "=="
            ? "eq"
            : operator === "!="
              ? "neq"
              : operator === "<"
                ? "lt"
                : operator === "<="
                  ? "lte"
                  : operator === ">"
                    ? "gt"
                    : "gte";
        left = { op, left, right };
        continue;
      }
      left =
        operator === "+"
          ? { op: "add", args: [left, right] }
          : operator === "-"
            ? { op: "subtract", args: [left, right] }
            : operator === "*"
              ? { op: "multiply", args: [left, right] }
              : { op: "divide", args: [left, right] };
    }
    return left;
  };
  const primary = (): FlowFormula => {
    const token = tokens[index++];
    if (token === undefined) throw new Error("Enter a formula.");
    if (token.text === "(") {
      const part = expression();
      take(")");
      return part;
    }
    if (token.text === "-")
      return {
        op: "subtract",
        args: [{ op: "literal", type: "whole_number", value: 0 }, primary()],
      };
    if (token.kind === "number") {
      if (token.text.includes("."))
        return {
          op: "literal",
          type: "decimal_number",
          value: normalizeExactDecimal(token.text) ?? token.text,
        };
      const number = Number(token.text);
      if (!Number.isSafeInteger(number))
        throw new Error("Whole numbers must be within the safe integer range.");
      return { op: "literal", type: "whole_number", value: number };
    }
    if (token.kind === "string")
      return { op: "literal", type: "text", value: JSON.parse(token.text) as string };
    if (token.kind !== "name") throw new Error(`Unexpected ${token.text}.`);
    if (token.text === "true" || token.text === "false")
      return { op: "literal", type: "yes_no", value: token.text === "true" };
    if (peek() !== "(") {
      const matches = references.filter((reference) => reference.name === token.text);
      if (matches.length !== 1)
        throw new Error(
          matches.length === 0
            ? `Unknown value ${token.text}.`
            : `The name ${token.text} is ambiguous.`,
        );
      return { op: "reference", reference: matches[0]!.reference };
    }
    take("(");
    const args: FlowFormula[] = [];
    if (peek() !== ")") {
      args.push(expression());
      while (peek() === ",") {
        take(",");
        args.push(expression());
      }
    }
    take(")");
    if (token.text === "tree" || token.text === "ref") {
      const textValue = literal(args[0]);
      if (args.length !== 1 || typeof textValue !== "string")
        throw new Error(`${token.text} needs one quoted JSON value.`);
      const raw: unknown = JSON.parse(textValue);
      const parsed = flowFormulaSchema.safeParse(
        token.text === "ref" ? { op: "reference", reference: raw } : raw,
      );
      if (!parsed.success) throw new Error("The typed formula tree is invalid.");
      return parsed.data;
    }
    if (token.text === "decimal") {
      const amount = literal(args[0]);
      if (args.length !== 1 || typeof amount !== "string")
        throw new Error("decimal needs one quoted exact number.");
      return {
        op: "literal",
        type: "decimal_number",
        value: normalizeExactDecimal(amount) ?? amount,
      };
    }
    if (token.text === "round" || token.text === "percent") {
      const count = token.text === "round" ? 2 : 3;
      const places = literal(args[count - 1]);
      const mode = args.length === count + 1 ? literal(args[count]) : "half_even";
      if (
        (args.length !== count && args.length !== count + 1) ||
        typeof places !== "number" ||
        !Number.isInteger(places) ||
        !flowRoundingModeSchema.safeParse(mode).success
      )
        throw new Error(
          `${token.text} needs a value, whole-number places and an optional quoted rounding mode.`,
        );
      return token.text === "round"
        ? { op: "round", arg: args[0]!, scale: places, rounding: mode as FlowRoundingMode }
        : {
            op: "percent",
            args: [args[0]!, args[1]!],
            scale: places,
            rounding: mode as FlowRoundingMode,
          };
    }
    if (token.text === "min" || token.text === "max" || token.text === "coalesce")
      return { op: token.text, args };
    if (token.text === "join") return { op: "join", parts: args };
    throw new Error(`Unknown function ${token.text}.`);
  };
  const formula = expression();
  if (index !== tokens.length) throw new Error(`Unexpected ${tokens[index]!.text}.`);
  const parsed = flowFormulaSchema.safeParse(formula);
  if (!parsed.success)
    throw new Error(parsed.error.issues[0]?.message ?? "This formula is invalid.");
  return parsed.data;
};

const printFormula = (
  formula: FlowFormula,
  references: readonly FormulaReferenceChoice[],
): string => {
  const print = (node: FlowFormula): string => {
    switch (node.op) {
      case "literal":
        if (node.type === "whole_number" || node.type === "yes_no") return String(node.value);
        if (node.type === "decimal_number") return `decimal(${JSON.stringify(node.value)})`;
        if (node.type === "text") return JSON.stringify(node.value);
        break;
      case "reference": {
        const choice = references.find(
          (entry) => JSON.stringify(entry.reference) === JSON.stringify(node.reference),
        );
        return choice !== undefined && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(choice.name)
          ? choice.name
          : `ref(${JSON.stringify(JSON.stringify(node.reference))})`;
      }
      case "add":
      case "subtract":
      case "multiply":
      case "divide": {
        const symbol =
          node.op === "add"
            ? "+"
            : node.op === "subtract"
              ? "-"
              : node.op === "multiply"
                ? "*"
                : "/";
        return `(${node.args.map(print).join(` ${symbol} `)})`;
      }
      case "eq":
      case "neq":
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        const symbol =
          node.op === "eq"
            ? "=="
            : node.op === "neq"
              ? "!="
              : node.op === "lt"
                ? "<"
                : node.op === "lte"
                  ? "<="
                  : node.op === "gt"
                    ? ">"
                    : ">=";
        return `(${print(node.left)} ${symbol} ${print(node.right)})`;
      }
      case "round":
        return `round(${print(node.arg)}, ${node.scale}, ${JSON.stringify(node.rounding)})`;
      case "percent":
        return `percent(${print(node.args[0])}, ${print(node.args[1])}, ${node.scale}, ${JSON.stringify(node.rounding)})`;
      case "min":
      case "max":
      case "coalesce":
        return `${node.op}(${node.args.map(print).join(", ")})`;
      case "join":
        if (node.separator === undefined || node.separator === "")
          return `join(${node.parts.map(print).join(", ")})`;
        break;
    }
    return `tree(${JSON.stringify(JSON.stringify(node))})`;
  };
  return print(formula);
};

export function StudioFormulaEditor({
  id,
  value,
  references,
  disabled,
  onChange,
}: Readonly<{
  id: string;
  value: FlowFormula;
  references: readonly FormulaReferenceChoice[];
  disabled: boolean;
  onChange: (formula: FlowFormula | undefined, error?: string) => void;
}>) {
  const inspect = (formula: FlowFormula) => {
    const issues: string[] = [];
    const type = checkFlowFormula(formula, {
      nowAllowed: true,
      reference: (reference) => {
        const choice = references.find(
          (entry) => JSON.stringify(entry.reference) === JSON.stringify(reference),
        );
        if (choice?.type === undefined) issues.push("Choose a value with a declared type.");
        return choice?.type;
      },
      issue: (_path, _rule, _family, message) => issues.push(message),
    });
    const unavailable = (node: FlowFormula): boolean =>
      (node.op === "reference" &&
        (node.reference.source === "page" || node.reference.source === "form")) ||
      flowFormulaChildren(node).some(unavailable);
    return {
      error: issues[0],
      type,
      warning: unavailable(formula) ? "Page and form values cannot be read yet." : undefined,
    };
  };
  const [text, setText] = useState(() => printFormula(value, references));
  const [problem, setProblem] = useState<string | undefined>(() => inspect(value).error);
  const [resultType, setResultType] = useState<string | undefined>(() => inspect(value).type);
  const [warning, setWarning] = useState<string | undefined>(() => inspect(value).warning);
  const edit = (next: string) => {
    setText(next);
    try {
      const formula = parseFormula(next, references);
      const { error, type, warning: nextWarning } = inspect(formula);
      setProblem(error);
      setResultType(type);
      setWarning(nextWarning);
      onChange(formula, error);
    } catch (error) {
      const message = error instanceof Error ? error.message : "This formula is invalid.";
      setProblem(message);
      setResultType(undefined);
      setWarning(undefined);
      onChange(undefined, message);
    }
  };
  const suffix = /[A-Za-z_][A-Za-z0-9_.]*$/.exec(text)?.[0] ?? "";
  const suggestions = [
    ...references.map((entry) => entry.name),
    "round(",
    "min(",
    "max(",
    "coalesce(",
    "percent(",
    "join(",
  ]
    .filter((entry) => suffix !== "" && entry.startsWith(suffix) && entry !== suffix)
    .slice(0, 8);
  return (
    <div className="space-y-2">
      <Input
        id={id}
        disabled={disabled}
        value={text}
        onChange={(event) => edit(event.target.value)}
        aria-invalid={problem !== undefined}
        aria-describedby={`${id}-feedback`}
      />
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1" aria-label="Formula suggestions">
          {suggestions.map((suggestion) => (
            <Button
              key={suggestion}
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => edit(text.slice(0, -suffix.length) + suggestion)}
            >
              {suggestion}
            </Button>
          ))}
        </div>
      )}
      <p
        id={`${id}-feedback`}
        className="text-sm"
        role={problem === undefined ? undefined : "alert"}
      >
        {problem ?? (resultType === undefined ? "Enter a formula." : `Result: ${resultType}`)}
        {warning === undefined ? "" : ` ${warning}`}
      </p>
    </div>
  );
}
