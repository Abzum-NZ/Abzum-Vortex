import { calculationFormulaDependencies as calculationDependencies } from "../definition/module-calculation-formula";
import { jsonValueSchema, type JsonValue } from "../catalogue/common";
import { timestampSchema } from "../catalogue/identifiers";
import {
  recordTypeDefinitionSchema,
  type ModuleField,
  type RecordTypeDefinition,
} from "../definition/module-contracts";
import type { FlowFormula } from "../workflows/flow-values";
import { formatExactDecimal, parseExactDecimal } from "./exact-decimal";
import { moneyValueSchema } from "./module-field-values";
import { evaluateFlowFormula, type FlowFormulaScope } from "../rules/flow-formula";
import { persistedRecordFieldValueMatches } from "./field-values";

type CalculationField = Extract<ModuleField, { type: "calculation" }>;
export type RecordCalculationClock = Readonly<{
  instant: string;
  organizationLocalDate: string;
}>;

export type EvaluateRecordCalculationsInput = Readonly<{
  recordType: RecordTypeDefinition;
  authoritativeFieldValues: Readonly<Record<string, unknown>>;
  clock: RecordCalculationClock;
}>;

export type RecordCalculationIssueCode =
  | "invalid_input"
  | "execution_ineligible"
  | "invalid_dependency_value"
  | "division_by_zero"
  | "result_overflow"
  | "money_dimension_mismatch"
  | "non_integral_whole_number"
  | "calculation_cycle"
  | "condition_refused"
  | "required_result_missing"
  | "invalid_result";

export type RecordCalculationIssue = Readonly<{
  code: RecordCalculationIssueCode;
  fieldId?: string;
  path: readonly (string | number)[];
}>;

export type EvaluateRecordCalculationsResult =
  | Readonly<{
      success: true;
      setValues: Readonly<Record<string, JsonValue>>;
      clearFieldIds: readonly string[];
    }>
  | Readonly<{
      success: false;
      issues: readonly RecordCalculationIssue[];
    }>;

const isValueMap = (candidate: unknown): candidate is Readonly<Record<string, unknown>> =>
  candidate !== null && typeof candidate === "object" && !Array.isArray(candidate);

const validCalendarDate = (candidate: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(candidate);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
};

const resultTypeOf = (field: ModuleField): string =>
  field.type === "calculation" || field.type === "total" ? field.settings.resultType : field.type;

const formulaTypeOf = (field: ModuleField): string => {
  const type = resultTypeOf(field);
  switch (type) {
    case "yes_no":
      return "yes_no";
    case "long_text":
    case "reference_number":
    case "email_address":
    case "phone_number":
    case "web_address":
      return "text";
    case "link":
    case "link_to_one_of_several":
      return "record_reference";
    case "table":
    case "attachment":
      return "json";
    default:
      return type;
  }
};

const issue = (
  code: RecordCalculationIssueCode,
  fieldId?: string,
  path: readonly (string | number)[] = ["recordType"],
): RecordCalculationIssue => ({ code, ...(fieldId === undefined ? {} : { fieldId }), path });

const currencyOf = (candidate: JsonValue): string | undefined => {
  const parsed = moneyValueSchema.safeParse(candidate);
  return parsed.success ? parsed.data.currency : undefined;
};

const zeroValue = (candidate: JsonValue): boolean => {
  const amount =
    candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
      ? (candidate as { amount?: unknown }).amount
      : candidate;
  if (typeof amount !== "string" && typeof amount !== "number") return false;
  return parseExactDecimal(String(amount))?.coefficient === 0n;
};

const formulaFailure = (
  formula: FlowFormula,
  scope: FlowFormulaScope,
): RecordCalculationIssueCode | undefined => {
  const evaluate = (candidate: FlowFormula) => evaluateFlowFormula(candidate, scope);
  if (
    formula.op === "add" ||
    formula.op === "subtract" ||
    formula.op === "multiply" ||
    formula.op === "divide"
  ) {
    const operands = formula.args.map(evaluate);
    if (operands.every((operand) => operand !== undefined)) {
      const money = operands.filter((operand) => operand!.type === "money");
      const currencies = money.map((operand) => currencyOf(operand!.value));
      const commonCurrency =
        currencies.length > 0 &&
        currencies.every((currency) => currency !== undefined && currency === currencies[0]);
      const valid =
        formula.op === "add" || formula.op === "subtract"
          ? money.length === 0 || (money.length === operands.length && commonCurrency)
          : formula.op === "multiply"
            ? money.length <= 1
            : money.length === 0 ||
              (money.length === 1 && operands[0]?.type === "money" && commonCurrency);
      if (!valid) return "money_dimension_mismatch";
      if (formula.op === "divide" && operands.slice(1).some((operand) => zeroValue(operand!.value)))
        return "division_by_zero";
    }
    for (const child of formula.args) {
      const failure = formulaFailure(child, scope);
      if (failure !== undefined) return failure;
    }
  } else if (formula.op === "round") return formulaFailure(formula.arg, scope);
  else if (formula.op === "date_add") {
    const amount = evaluate(formula.amount);
    if (amount?.type === "money") return "money_dimension_mismatch";
  }
  return undefined;
};

/**
 * Evaluates every stored calculation from the owning operation's complete authoritative values
 * using the shared flow formula evaluator. It performs no reads, writes or access decisions.
 */
export const evaluateRecordCalculations = (
  input: EvaluateRecordCalculationsInput,
  validatedFields?: ReadonlyMap<string, ModuleField>,
): EvaluateRecordCalculationsResult => {
  const parsedRecordType =
    validatedFields === undefined
      ? recordTypeDefinitionSchema.safeParse(input.recordType)
      : { success: true as const, data: input.recordType };
  if (
    !parsedRecordType.success ||
    !isValueMap(input.authoritativeFieldValues) ||
    typeof input.clock?.instant !== "string" ||
    !timestampSchema.safeParse(input.clock.instant).success ||
    typeof input.clock?.organizationLocalDate !== "string" ||
    !validCalendarDate(input.clock.organizationLocalDate)
  )
    return { success: false, issues: [issue("invalid_input")] };

  const recordType = parsedRecordType.data;
  const fields =
    validatedFields ??
    new Map<string, ModuleField>(recordType.fields.map((field) => [field.fieldId, field]));
  const calculations = recordType.fields.filter(
    (field): field is CalculationField => field.type === "calculation",
  );
  const calculationIds = new Set<string>(calculations.map((field) => field.fieldId));
  if (Object.keys(input.authoritativeFieldValues).some((fieldId) => !fields.has(fieldId)))
    return {
      success: false,
      issues: [issue("invalid_input", undefined, ["authoritativeFieldValues"])],
    };

  const values = new Map<string, JsonValue>();
  const invalidValues: RecordCalculationIssue[] = [];
  for (const [fieldId, candidate] of Object.entries(input.authoritativeFieldValues)) {
    const field = fields.get(fieldId)!;
    if (calculationIds.has(fieldId)) continue;
    if (
      !jsonValueSchema.safeParse(candidate).success ||
      !persistedRecordFieldValueMatches({ field, value: candidate })
    )
      invalidValues.push(
        issue("invalid_dependency_value", fieldId, ["authoritativeFieldValues", fieldId]),
      );
    else values.set(fieldId, candidate as JsonValue);
  }
  if (invalidValues.length > 0) return { success: false, issues: invalidValues };

  const dependencies = new Map(
    calculations.map((field) => [
      field.fieldId,
      calculationDependencies(field.settings.expression),
    ]),
  );
  for (const field of calculations)
    if (
      JSON.stringify([...new Set(field.settings.dependencyFieldIds)]) !==
        JSON.stringify(dependencies.get(field.fieldId)) ||
      (["decimal_number", "money"].includes(field.settings.resultType) &&
        field.settings.decimalPlaces === undefined)
    )
      return { success: false, issues: [issue("execution_ineligible", field.fieldId)] };

  const order: CalculationField[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  let cycleFieldId: string | undefined;
  const visit = (field: CalculationField): void => {
    if (visited.has(field.fieldId) || cycleFieldId !== undefined) return;
    if (visiting.has(field.fieldId)) {
      cycleFieldId = field.fieldId;
      return;
    }
    visiting.add(field.fieldId);
    for (const dependencyId of dependencies.get(field.fieldId) ?? []) {
      const dependency = fields.get(dependencyId);
      if (dependency?.type === "calculation") visit(dependency);
    }
    visiting.delete(field.fieldId);
    visited.add(field.fieldId);
    order.push(field);
  };
  calculations.forEach(visit);
  if (cycleFieldId !== undefined)
    return { success: false, issues: [issue("calculation_cycle", cycleFieldId)] };

  const setValues: Record<string, JsonValue> = {};
  const clearFieldIds: string[] = [];
  const issues: RecordCalculationIssue[] = [];
  const missing = (field: CalculationField) => {
    if (field.required) issues.push(issue("required_result_missing", field.fieldId));
    else clearFieldIds.push(field.fieldId);
  };

  for (const field of order) {
    let calculated: JsonValue | undefined;
    let evaluationIssue: RecordCalculationIssueCode | undefined;
    const formula = field.settings.expression;
    const declaredDependencies = new Set(field.settings.dependencyFieldIds);
    const scope: FlowFormulaScope = {
      now: input.clock.instant,
      organizationLocalDate: input.clock.organizationLocalDate,
      reference: (reference) => {
        if (reference.source !== "module_field" || !declaredDependencies.has(reference.fieldId))
          return undefined;
        const dependency = fields.get(reference.fieldId);
        if (dependency === undefined) return undefined;
        return {
          type: formulaTypeOf(dependency),
          value: values.get(reference.fieldId) ?? null,
        };
      },
    };
    const evaluated = evaluateFlowFormula(formula, scope, {
      preserveExactArithmetic: true,
      ...(field.settings.decimalPlaces === undefined
        ? {}
        : { resultScale: field.settings.decimalPlaces }),
    });
    const exactWhole =
      field.settings.resultType === "whole_number" && evaluated !== undefined
        ? evaluateFlowFormula(formula, scope, {
            preserveExactArithmetic: true,
            requireExactInteger: true,
          })
        : evaluated;
    if (evaluated !== undefined) {
      if (field.settings.resultType === "money" && evaluated.type !== "money")
        evaluationIssue = "money_dimension_mismatch";
      else if (field.settings.resultType !== "money" && evaluated.type === "money")
        evaluationIssue = "money_dimension_mismatch";
      else if (exactWhole === undefined) evaluationIssue = "non_integral_whole_number";
      else if (field.settings.resultType === "whole_number") {
        const exact = parseExactDecimal(String(evaluated.value));
        if (exact === undefined || exact.scale !== 0) evaluationIssue = "non_integral_whole_number";
        else if (
          exact.coefficient < BigInt(Number.MIN_SAFE_INTEGER) ||
          exact.coefficient > BigInt(Number.MAX_SAFE_INTEGER)
        )
          evaluationIssue = "result_overflow";
        else calculated = Number(exact.coefficient);
      } else if (field.settings.resultType === "decimal_number") {
        const exact = parseExactDecimal(String(evaluated.value));
        if (exact === undefined) evaluationIssue = "invalid_result";
        else calculated = formatExactDecimal(exact);
      } else calculated = evaluated.value;
    } else if (
      calculationDependencies(formula).every(
        (id) => values.get(id) !== undefined && values.get(id) !== null,
      )
    ) {
      evaluationIssue = formulaFailure(formula, scope) ?? "invalid_result";
    }

    if (evaluationIssue !== undefined) {
      issues.push(issue(evaluationIssue, field.fieldId));
      continue;
    }
    if (calculated === undefined) {
      missing(field);
      continue;
    }
    if (!persistedRecordFieldValueMatches({ field, value: calculated })) {
      issues.push(issue("invalid_result", field.fieldId));
      continue;
    }
    values.set(field.fieldId, calculated);
    setValues[field.fieldId] = calculated;
  }

  return issues.length > 0
    ? { success: false, issues }
    : { success: true, setValues, clearFieldIds };
};
