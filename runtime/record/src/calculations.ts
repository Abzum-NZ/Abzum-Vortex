import {
  formatExactDecimal,
  jsonValueSchema,
  moneyValueV2Schema,
  parseExactDecimal,
  recordTypeDefinitionV3Schema,
  timestampSchema,
  type FlowFormula,
  type JsonValue,
  type ModuleFieldV3,
  type RecordTypeDefinitionV3,
} from "@vortex/contracts";
import { evaluateFlowFormula, evaluateTypedConditionV2 } from "@vortex/rule";
import { persistedRecordFieldValueMatches } from "./field-values";

type CalculationField = Extract<ModuleFieldV3, { type: "calculation" }>;
type CalculationExpression = CalculationField["settings"]["expression"];
type CalculationNumberValue = Extract<CalculationExpression, { kind: "numeric" }>["operands"][number];
type DateOffsetAmount = Extract<CalculationExpression, { kind: "date_offset" }>["amount"];

export type RecordCalculationClock = Readonly<{
  instant: string;
  organizationLocalDate: string;
}>;

export type EvaluateRecordCalculationsInput = Readonly<{
  recordType: RecordTypeDefinitionV3;
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

const calculationDependencies = (expression: CalculationExpression): string[] => {
  const dependencies: string[] = [];
  const add = (fieldId: string | undefined) => {
    if (fieldId !== undefined && !dependencies.includes(fieldId)) dependencies.push(fieldId);
  };
  const visitCondition = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== "object") return;
    if (!Array.isArray(candidate)) {
      const entry = candidate as Readonly<Record<string, unknown>>;
      if (entry.source === "field" && typeof entry.fieldId === "string") add(entry.fieldId);
    }
    for (const child of Array.isArray(candidate) ? candidate : Object.values(candidate))
      visitCondition(child);
  };
  const visitNumber = (candidate: CalculationNumberValue): void => {
    if (candidate.source === "numeric") candidate.operands.forEach(visitNumber);
    else if (candidate.source === "field") add(candidate.fieldId);
  };
  switch (expression.kind) {
    case "join_text":
      expression.fieldIds.forEach(add);
      break;
    case "numeric":
      expression.operands.forEach(visitNumber);
      break;
    case "condition":
      visitCondition(expression.condition);
      break;
    case "date_offset":
      add(expression.dateFieldId);
      if (expression.amount.source === "field") add(expression.amount.fieldId);
      break;
    case "deadline_passed":
      add(expression.dueFieldId);
      add(expression.statusFieldId);
      break;
  }
  return dependencies;
};

const resultTypeOf = (field: ModuleFieldV3): string =>
  field.type === "calculation" || field.type === "total" ? field.settings.resultType : field.type;

const formulaTypeOf = (field: ModuleFieldV3): string => {
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
    case "link_to_person":
      return "organization_account_reference";
    case "table":
    case "attachment":
      return "json";
    default:
      return type;
  }
};

const literal = (type: string, value: JsonValue): FlowFormula =>
  ({ op: "literal", type, value }) as unknown as FlowFormula;

const fieldFormula = (
  fieldId: string,
  fields: ReadonlyMap<string, ModuleFieldV3>,
  values: ReadonlyMap<string, JsonValue>,
): FlowFormula | undefined => {
  const field = fields.get(fieldId);
  if (field === undefined) return undefined;
  return literal(formulaTypeOf(field), values.get(fieldId) ?? null);
};

const numericOperation = (
  operation: "add" | "subtract" | "multiply" | "divide",
  operands: readonly FlowFormula[],
  scale = 18,
): FlowFormula => {
  if (operation === "add" || operation === "multiply") {
    if (operands.length <= 10)
      return { op: operation, args: [...operands], scale, rounding: "half_even" };
    const groups: FlowFormula[] = [];
    for (let index = 0; index < operands.length; index += 10) {
      const group = operands.slice(index, index + 10);
      groups.push(group.length === 1 ? group[0]! : numericOperation(operation, group));
    }
    return { op: operation, args: groups, scale, rounding: "half_even" };
  }
  return operands.slice(1).reduce<FlowFormula>(
    (current, next, index) => ({
      op: operation,
      args: [current, next],
      scale: index === operands.length - 2 ? scale : 18,
      rounding: "half_even",
    }),
    operands[0]!,
  );
};

const numberFormula = (
  operand: CalculationNumberValue,
  fields: ReadonlyMap<string, ModuleFieldV3>,
  values: ReadonlyMap<string, JsonValue>,
): FlowFormula | undefined => {
  if (operand.source === "literal") return literal("decimal_number", operand.value);
  if (operand.source === "field") return fieldFormula(operand.fieldId, fields, values);
  const children = operand.operands.map((child) => numberFormula(child, fields, values));
  if (children.some((child) => child === undefined)) return undefined;
  return numericOperation(operand.operation, children as FlowFormula[]);
};

const dateAmountFormula = (
  amount: DateOffsetAmount,
  fields: ReadonlyMap<string, ModuleFieldV3>,
  values: ReadonlyMap<string, JsonValue>,
): FlowFormula | undefined => {
  if (amount.source === "literal") {
    const whole = Number(amount.value);
    return Number.isSafeInteger(whole)
      ? literal("whole_number", whole)
      : literal("whole_number", null);
  }
  const field = fields.get(amount.fieldId);
  if (!field) return undefined;
  const candidate = values.get(amount.fieldId);
  if (candidate === undefined || candidate === null) return literal("whole_number", null);
  if (formulaTypeOf(field) === "money") return literal("money", candidate);
  const whole = typeof candidate === "number" ? candidate : Number(candidate);
  return Number.isSafeInteger(whole) ? literal("whole_number", whole) : literal("whole_number", null);
};

const deadlineFormula = (
  field: CalculationField,
  fields: ReadonlyMap<string, ModuleFieldV3>,
  values: ReadonlyMap<string, JsonValue>,
): FlowFormula | undefined => {
  const expression = field.settings.expression;
  if (expression.kind !== "deadline_passed") return undefined;
  const dueField = fields.get(expression.dueFieldId);
  const due = fieldFormula(expression.dueFieldId, fields, values);
  if (!dueField || !due) return undefined;
  const dueType = formulaTypeOf(dueField);
  const passed =
    dueType === "date"
      ? {
          op: "lte" as const,
          left: {
            op: "date_add" as const,
            date: due,
            amount: literal("whole_number", 1),
            unit: "days" as const,
          },
          right: { op: "now" as const },
        }
      : { op: "lte" as const, left: due, right: { op: "now" as const } };
  if (!expression.statusFieldId || expression.terminalStatusValues.length === 0) return passed;
  const statusField = fields.get(expression.statusFieldId);
  const status = fieldFormula(expression.statusFieldId, fields, values);
  if (!statusField || !status) return undefined;
  const statusType = formulaTypeOf(statusField);
  const terminal = {
    op: "in" as const,
    value: status,
    options: expression.terminalStatusValues.map((value) => literal(statusType, value)),
  };
  return {
    op: "if",
    condition: terminal,
    then: literal("yes_no", false),
    else: passed,
  };
};

const calculationFormula = (
  field: CalculationField,
  fields: ReadonlyMap<string, ModuleFieldV3>,
  values: ReadonlyMap<string, JsonValue>,
): FlowFormula | undefined => {
  const expression = field.settings.expression;
  if (expression.kind === "join_text") {
    const parts = expression.fieldIds.map((fieldId) => fieldFormula(fieldId, fields, values));
    if (parts.some((part) => part === undefined)) return undefined;
    return {
      op: "join",
      parts: parts as FlowFormula[],
      separator: expression.separator,
    };
  }
  if (expression.kind === "numeric") {
    const operands = expression.operands.map((operand) => numberFormula(operand, fields, values));
    if (operands.some((operand) => operand === undefined)) return undefined;
    const precision =
      field.settings.resultType === "whole_number" ? 18 : field.settings.decimalPlaces ?? 12;
    return numericOperation(expression.operation, operands as FlowFormula[], precision);
  }
  if (expression.kind === "date_offset") {
    const date = fieldFormula(expression.dateFieldId, fields, values);
    const amount = dateAmountFormula(expression.amount, fields, values);
    if (!date || !amount) return undefined;
    return { op: "date_add", date, amount, unit: expression.unit };
  }
  if (expression.kind === "deadline_passed") return deadlineFormula(field, fields, values);
  return undefined;
};

const issue = (
  code: RecordCalculationIssueCode,
  fieldId?: string,
  path: readonly (string | number)[] = ["recordType"],
): RecordCalculationIssue => ({ code, ...(fieldId === undefined ? {} : { fieldId }), path });

const currencyOf = (candidate: JsonValue): string | undefined => {
  const parsed = moneyValueV2Schema.safeParse(candidate);
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
  input: EvaluateRecordCalculationsInput,
): RecordCalculationIssueCode | undefined => {
  const evaluate = (candidate: FlowFormula) =>
    evaluateFlowFormula(candidate, {
      now: input.clock.instant,
      reference: () => undefined,
    });
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
      const failure = formulaFailure(child, input);
      if (failure !== undefined) return failure;
    }
  } else if (formula.op === "round") return formulaFailure(formula.arg, input);
  else if (formula.op === "date_add") {
    const amount = evaluate(formula.amount);
    if (amount?.type === "money") return "money_dimension_mismatch";
  }
  return undefined;
};

const calculationInputsPresent = (
  field: CalculationField,
  values: ReadonlyMap<string, JsonValue>,
): boolean => {
  const expression = field.settings.expression;
  const requiredIds =
    expression.kind === "deadline_passed"
      ? [expression.dueFieldId]
      : calculationDependencies(expression);
  return requiredIds.every((fieldId) => {
    const value = values.get(fieldId);
    return value !== undefined && value !== null;
  });
};

const evaluateCondition = (
  field: CalculationField,
  recordType: RecordTypeDefinitionV3,
  values: ReadonlyMap<string, JsonValue>,
): boolean | undefined => {
  const expression = field.settings.expression;
  if (expression.kind !== "condition") return undefined;
  const dependencies = calculationDependencies(expression);
  try {
    return evaluateTypedConditionV2({
      condition: expression.condition,
      sourceRecordFields: recordType.fields,
      declaredFieldIds: dependencies,
      parameterDeclarations: [],
      fieldValues: Object.fromEntries(
        dependencies.map((fieldId) => [fieldId, values.get(fieldId) ?? null]),
      ),
      parameterValues: {},
    });
  } catch {
    return undefined;
  }
};

/**
 * Evaluates every stored calculation from the owning operation's complete authoritative values
 * using the shared flow formula evaluator. It performs no reads, writes or access decisions.
 */
export const evaluateRecordCalculations = (
  input: EvaluateRecordCalculationsInput,
): EvaluateRecordCalculationsResult => {
  const parsedRecordType = recordTypeDefinitionV3Schema.safeParse(input.recordType);
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
  const fields = new Map<string, ModuleFieldV3>(
    recordType.fields.map((field) => [field.fieldId, field]),
  );
  const calculations = recordType.fields.filter(
    (field): field is CalculationField => field.type === "calculation",
  );
  const calculationIds = new Set(calculations.map((field) => field.fieldId));
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
      invalidValues.push(issue("invalid_dependency_value", fieldId, ["authoritativeFieldValues", fieldId]));
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
    if (field.settings.expression.kind === "condition") {
      const result = evaluateCondition(field, recordType, values);
      if (result !== undefined) calculated = result;
      else if (dependencies.get(field.fieldId)!.every((fieldId) => values.has(fieldId)))
        evaluationIssue = "condition_refused";
    } else {
      const formula = calculationFormula(field, fields, values);
      if (formula === undefined) {
        evaluationIssue = "execution_ineligible";
      } else {
        const dueField =
          field.settings.expression.kind === "deadline_passed"
            ? fields.get(field.settings.expression.dueFieldId)
            : undefined;
        const now =
          dueField !== undefined && formulaTypeOf(dueField) === "date"
            ? input.clock.organizationLocalDate + "T00:00:00.000Z"
            : input.clock.instant;
        const evaluated = evaluateFlowFormula(formula, {
          now,
          reference: () => undefined,
        });
        if (evaluated !== undefined) {
          if (field.settings.resultType === "money" && evaluated.type !== "money")
            evaluationIssue = "money_dimension_mismatch";
          else if (field.settings.resultType !== "money" && evaluated.type === "money")
            evaluationIssue = "money_dimension_mismatch";
          else if (field.settings.resultType === "whole_number") {
            const exact = parseExactDecimal(evaluated.value);
            if (exact === undefined || exact.scale !== 0)
              evaluationIssue = "non_integral_whole_number";
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
        } else if (calculationInputsPresent(field, values)) {
          evaluationIssue =
            formulaFailure(formula, { ...input, clock: { ...input.clock, instant: now } }) ??
            "invalid_result";
        }
      }
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

const isReadTimeCalculationField = (field: CalculationField): boolean =>
  field.settings.evaluation === "read_time" || field.settings.expression.kind === "deadline_passed";

/** Returns calculation fields that are worked out whenever their record is read. */
export const readTimeCalculationFieldIds = (recordType: RecordTypeDefinitionV3): readonly string[] => {
  const calculations = recordType.fields.filter(
    (field): field is CalculationField => field.type === "calculation",
  );
  const readTime = new Set(
    calculations.filter(isReadTimeCalculationField).map((field) => field.fieldId),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const field of calculations)
      if (
        !readTime.has(field.fieldId) &&
        calculationDependencies(field.settings.expression).some((fieldId) => readTime.has(fieldId))
      ) {
        readTime.add(field.fieldId);
        changed = true;
      }
  }
  return calculations.filter((field) => readTime.has(field.fieldId)).map((field) => field.fieldId);
};

export type EvaluateReadTimeCalculationsResult =
  | Readonly<{
      success: true;
      values: Readonly<Record<string, JsonValue>>;
      emptyFieldIds: readonly string[];
    }>
  | Readonly<{
      success: false;
      issues: readonly RecordCalculationIssue[];
    }>;

/** Evaluates read-time calculated fields through the same formula engine as a save. */
export const evaluateReadTimeCalculations = (
  input: EvaluateRecordCalculationsInput,
): EvaluateReadTimeCalculationsResult => {
  const parsed = recordTypeDefinitionV3Schema.safeParse(input.recordType);
  if (!parsed.success) return { success: false, issues: [issue("invalid_input")] };
  const readTimeIds = new Set(readTimeCalculationFieldIds(parsed.data));
  const evaluated = evaluateRecordCalculations({
    ...input,
    recordType: {
      ...parsed.data,
      fields: parsed.data.fields.map((field) =>
        readTimeIds.has(field.fieldId) ? { ...field, required: false } : field,
      ),
    },
  });
  if (!evaluated.success) return evaluated;
  return {
    success: true,
    values: Object.fromEntries(
      Object.entries(evaluated.setValues).filter(([fieldId]) => readTimeIds.has(fieldId)),
    ),
    emptyFieldIds: evaluated.clearFieldIds.filter((fieldId) => readTimeIds.has(fieldId)),
  };
};
