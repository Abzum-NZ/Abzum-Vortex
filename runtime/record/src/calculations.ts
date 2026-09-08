import {
  jsonValueSchema,
  moneyValueV2Schema,
  recordTypeDefinitionV2Schema,
  timestampSchema,
  type JsonValue,
  type ModuleFieldV2,
  type RecordTypeDefinitionV2,
} from "@vortex/contracts";
import { evaluateTypedConditionV2 } from "@vortex/rule";
import {
  addRationals,
  divideRationals,
  multiplyRationals,
  rationalFromExactText,
  rationalFromWholeNumber,
  rationalToSafeWholeNumber,
  roundRationalHalfEven,
  subtractRationals,
  type ExactRational,
} from "./exact-arithmetic";
import { persistedRecordFieldValueMatches } from "./field-values";

type CalculationFieldV2 = Extract<ModuleFieldV2, { type: "calculation" }>;
type CalculationExpressionV2 = CalculationFieldV2["settings"]["expression"];
type CalculationNumberOperandV2 = Extract<
  CalculationExpressionV2,
  { kind: "numeric" }
>["operands"][number];

export type RecordCalculationClockV2 = Readonly<{
  instant: string;
  organizationLocalDate: string;
}>;

export type EvaluateRecordCalculationsV2Input = Readonly<{
  recordType: RecordTypeDefinitionV2;
  authoritativeFieldValues: Readonly<Record<string, unknown>>;
  clock: RecordCalculationClockV2;
}>;

export type RecordCalculationIssueCode =
  | "invalid_input"
  | "execution_ineligible"
  | "invalid_dependency_value"
  | "division_by_zero"
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

export type EvaluateRecordCalculationsV2Result =
  | Readonly<{
      success: true;
      setValues: Readonly<Record<string, JsonValue>>;
      clearFieldIds: readonly string[];
    }>
  | Readonly<{
      success: false;
      issues: readonly RecordCalculationIssue[];
    }>;

type NumericValue = Readonly<{
  value: ExactRational;
  currency?: string;
}>;

const isValueMap = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const utcDate = (
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date => {
  const output = new Date(0);
  output.setUTCFullYear(year, month, day);
  output.setUTCHours(hour, minute, second, 0);
  return output;
};

const validCalendarDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = utcDate(year!, month! - 1, day!);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day
  );
};

type ExactInstant = Readonly<{ epochSecond: bigint; fraction: string }>;

const exactInstant = (value: string): ExactInstant | undefined => {
  if (!timestampSchema.safeParse(value).success) return undefined;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = ""] = match;
  const zone = match[8]!;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const utcMilliseconds = utcDate(year, month - 1, day, hour, minute, second).getTime();
  if (!Number.isFinite(utcMilliseconds)) return undefined;
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    offsetMinutes = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  }
  return {
    epochSecond: BigInt(utcMilliseconds / 1_000 - offsetMinutes * 60),
    fraction,
  };
};

const compareInstants = (left: ExactInstant, right: ExactInstant): -1 | 0 | 1 => {
  if (left.epochSecond < right.epochSecond) return -1;
  if (left.epochSecond > right.epochSecond) return 1;
  const scale = Math.max(left.fraction.length, right.fraction.length);
  const leftFraction = left.fraction.padEnd(scale, "0");
  const rightFraction = right.fraction.padEnd(scale, "0");
  return leftFraction < rightFraction ? -1 : leftFraction > rightFraction ? 1 : 0;
};

const calculationDependencies = (expression: CalculationExpressionV2): string[] => {
  const dependencies: string[] = [];
  const add = (fieldId: string | undefined) => {
    if (fieldId !== undefined && !dependencies.includes(fieldId)) dependencies.push(fieldId);
  };
  const visitCondition = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (!Array.isArray(value)) {
      const entry = value as Readonly<Record<string, unknown>>;
      if (entry.source === "field" && typeof entry.fieldId === "string") add(entry.fieldId);
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) visitCondition(child);
  };
  switch (expression.kind) {
    case "join_text":
      expression.fieldIds.forEach(add);
      break;
    case "numeric":
      expression.operands.forEach((operand) => {
        if (operand.source === "field") add(operand.fieldId);
      });
      break;
    case "subtract_percentage":
      add(expression.amountFieldId);
      add(expression.percentageFieldId);
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

const resultType = (field: ModuleFieldV2): string =>
  field.type === "calculation" || field.type === "total" ? field.settings.resultType : field.type;

const numericValue = (field: ModuleFieldV2, value: unknown): NumericValue | undefined => {
  const type = resultType(field);
  if (type === "whole_number") {
    const parsed = rationalFromWholeNumber(value);
    return parsed === undefined ? undefined : { value: parsed };
  }
  if (type === "decimal_number") {
    const parsed = rationalFromExactText(value);
    return parsed === undefined ? undefined : { value: parsed };
  }
  if (type === "money") {
    const parsedMoney = moneyValueV2Schema.safeParse(value);
    if (!parsedMoney.success) return undefined;
    const parsed = rationalFromExactText(parsedMoney.data.amount);
    return parsed === undefined
      ? undefined
      : { value: parsed, currency: parsedMoney.data.currency };
  }
  return undefined;
};

const sameCurrency = (values: readonly NumericValue[]): string | undefined => {
  const currencies = values.flatMap((value) =>
    value.currency === undefined ? [] : [value.currency],
  );
  return currencies.length > 0 && currencies.every((currency) => currency === currencies[0])
    ? currencies[0]
    : undefined;
};

const numericResult = (
  field: CalculationFieldV2,
  value: ExactRational,
  currency?: string,
): JsonValue | undefined => {
  const type = field.settings.resultType;
  if (type === "whole_number") return rationalToSafeWholeNumber(value);
  const decimalPlaces = field.settings.decimalPlaces;
  if (decimalPlaces === undefined) return undefined;
  const amount = roundRationalHalfEven(value, decimalPlaces);
  if (amount === undefined) return undefined;
  if (type === "decimal_number") return amount;
  return type === "money" && currency !== undefined ? { amount, currency } : undefined;
};

const daysInUtcMonth = (year: number, month: number): number =>
  utcDate(year, month + 1, 0).getUTCDate();

const offsetUtcDate = (
  date: Date,
  amount: number,
  unit: "days" | "weeks" | "months" | "years",
): Date | undefined => {
  const output = new Date(date.getTime());
  if (unit === "days" || unit === "weeks")
    output.setUTCDate(output.getUTCDate() + amount * (unit === "weeks" ? 7 : 1));
  else {
    const originalDay = output.getUTCDate();
    const monthDelta = amount * (unit === "years" ? 12 : 1);
    output.setUTCDate(1);
    output.setUTCMonth(output.getUTCMonth() + monthDelta);
    output.setUTCDate(
      Math.min(originalDay, daysInUtcMonth(output.getUTCFullYear(), output.getUTCMonth())),
    );
  }
  return Number.isNaN(output.getTime()) ? undefined : output;
};

const offsetDateValue = (
  value: string,
  amount: number,
  unit: "days" | "weeks" | "months" | "years",
  dateTime: boolean,
): string | undefined => {
  if (!dateTime) {
    if (!validCalendarDate(value)) return undefined;
    const [year, month, day] = value.split("-").map(Number);
    const output = offsetUtcDate(utcDate(year!, month! - 1, day!), amount, unit);
    return output?.toISOString().slice(0, 10);
  }
  if (!timestampSchema.safeParse(value).success) return undefined;
  const fraction = /(\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? "";
  const output = offsetUtcDate(new Date(value), amount, unit);
  if (!output) return undefined;
  return output.toISOString().replace(/\.\d{3}Z$/, `${fraction}Z`);
};

const issue = (
  code: RecordCalculationIssueCode,
  fieldId?: string,
  path: readonly (string | number)[] = ["recordType"],
): RecordCalculationIssue => ({ code, ...(fieldId === undefined ? {} : { fieldId }), path });

/**
 * Evaluates canonical Module V2 calculation fields from an owning operation's
 * complete authoritative values. It performs no reads, writes or access decisions.
 */
export const evaluateRecordCalculationsV2 = (
  input: EvaluateRecordCalculationsV2Input,
): EvaluateRecordCalculationsV2Result => {
  const parsedRecordType = recordTypeDefinitionV2Schema.safeParse(input.recordType);
  const operationInstant =
    typeof input.clock?.instant === "string" ? exactInstant(input.clock.instant) : undefined;
  if (
    !parsedRecordType.success ||
    !isValueMap(input.authoritativeFieldValues) ||
    operationInstant === undefined ||
    typeof input.clock?.organizationLocalDate !== "string" ||
    !validCalendarDate(input.clock.organizationLocalDate)
  )
    return { success: false, issues: [issue("invalid_input")] };

  const recordType = parsedRecordType.data;
  const fields = new Map<string, ModuleFieldV2>(
    recordType.fields.map((field) => [field.fieldId, field]),
  );
  const calculations = recordType.fields.filter(
    (field): field is CalculationFieldV2 => field.type === "calculation",
  );
  const calculationIds = new Set<string>(calculations.map((field) => field.fieldId));
  const suppliedKeys = Object.keys(input.authoritativeFieldValues);
  if (suppliedKeys.some((fieldId) => !fields.has(fieldId)))
    return {
      success: false,
      issues: [issue("invalid_input", undefined, ["authoritativeFieldValues"])],
    };

  const values = new Map<string, JsonValue>();
  const invalidValues: RecordCalculationIssue[] = [];
  for (const [fieldId, value] of Object.entries(input.authoritativeFieldValues)) {
    const field = fields.get(fieldId)!;
    if (calculationIds.has(fieldId)) continue;
    if (
      !jsonValueSchema.safeParse(value).success ||
      !persistedRecordFieldValueMatches({
        validationContractVersion: "2.0.0",
        field,
        value,
      })
    )
      invalidValues.push(
        issue("invalid_dependency_value", fieldId, ["authoritativeFieldValues", fieldId]),
      );
    else values.set(fieldId, value as JsonValue);
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
      return {
        success: false,
        issues: [issue("execution_ineligible", field.fieldId)],
      };

  const order: CalculationFieldV2[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  let cycleFieldId: string | undefined;
  const visit = (field: CalculationFieldV2): void => {
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
  const missing = (field: CalculationFieldV2) => {
    if (field.required) issues.push(issue("required_result_missing", field.fieldId));
    else clearFieldIds.push(field.fieldId);
  };
  const numericOperand = (operand: CalculationNumberOperandV2): NumericValue | undefined => {
    if (operand.source === "literal") {
      const value = rationalFromExactText(operand.value);
      return value === undefined ? undefined : { value };
    }
    const dependencyField = fields.get(operand.fieldId);
    const dependencyValue = values.get(operand.fieldId);
    return dependencyField === undefined || dependencyValue === undefined
      ? undefined
      : numericValue(dependencyField, dependencyValue);
  };

  for (const field of order) {
    const expression = field.settings.expression;
    let calculated: JsonValue | undefined;
    let evaluationIssue: RecordCalculationIssueCode | undefined;
    if (expression.kind === "join_text") {
      const entries = expression.fieldIds.map((fieldId) => values.get(fieldId));
      if (entries.every((entry) => typeof entry === "string"))
        calculated = (entries as string[]).join(expression.separator);
    } else if (expression.kind === "numeric") {
      const operands = expression.operands.map(numericOperand);
      if (operands.every((operand): operand is NumericValue => operand !== undefined)) {
        const currency = sameCurrency(operands);
        const moneyCount = operands.filter((operand) => operand.currency !== undefined).length;
        const dimensionsValid =
          expression.operation === "add" || expression.operation === "subtract"
            ? moneyCount === 0 || (moneyCount === operands.length && currency !== undefined)
            : expression.operation === "multiply"
              ? moneyCount <= 1
              : moneyCount === 0 || (moneyCount === 1 && operands[0]!.currency !== undefined);
        const resultExpectsMoney = field.settings.resultType === "money";
        if (!dimensionsValid || resultExpectsMoney !== moneyCount > 0)
          evaluationIssue = "money_dimension_mismatch";
        else {
          let accumulated = operands[0]!.value;
          for (const operand of operands.slice(1)) {
            if (expression.operation === "add")
              accumulated = addRationals(accumulated, operand.value);
            if (expression.operation === "subtract")
              accumulated = subtractRationals(accumulated, operand.value);
            if (expression.operation === "multiply")
              accumulated = multiplyRationals(accumulated, operand.value);
            if (expression.operation === "divide") {
              const divided = divideRationals(accumulated, operand.value);
              if (divided === undefined) {
                evaluationIssue = "division_by_zero";
                break;
              }
              accumulated = divided;
            }
          }
          if (evaluationIssue === undefined)
            calculated = numericResult(field, accumulated, currency ?? operands[0]!.currency);
        }
      }
    } else if (expression.kind === "subtract_percentage") {
      const amountField = fields.get(expression.amountFieldId);
      const percentageField = fields.get(expression.percentageFieldId);
      const amountValue = values.get(expression.amountFieldId);
      const percentageValue = values.get(expression.percentageFieldId);
      const amount =
        amountField && amountValue !== undefined
          ? numericValue(amountField, amountValue)
          : undefined;
      const percentage =
        percentageField && percentageValue !== undefined
          ? numericValue(percentageField, percentageValue)
          : undefined;
      if (amount && percentage && percentage.currency === undefined) {
        const hundred = rationalFromExactText("100")!;
        const fraction = divideRationals(percentage.value, hundred)!;
        calculated = numericResult(
          field,
          subtractRationals(amount.value, multiplyRationals(amount.value, fraction)),
          amount.currency,
        );
        if ((field.settings.resultType === "money") !== (amount.currency !== undefined))
          evaluationIssue = "money_dimension_mismatch";
      } else if (percentage?.currency !== undefined) evaluationIssue = "money_dimension_mismatch";
    } else if (expression.kind === "condition") {
      const declaredFieldIds = dependencies.get(field.fieldId) ?? [];
      const conditionValues = Object.fromEntries(
        declaredFieldIds.map((fieldId) => [fieldId, values.get(fieldId) ?? null]),
      );
      try {
        calculated = evaluateTypedConditionV2({
          condition: expression.condition,
          sourceRecordFields: recordType.fields,
          declaredFieldIds,
          parameterDeclarations: [],
          fieldValues: conditionValues,
          parameterValues: {},
        });
      } catch {
        evaluationIssue = "condition_refused";
      }
    } else if (expression.kind === "date_offset") {
      const dateField = fields.get(expression.dateFieldId);
      const dateValue = values.get(expression.dateFieldId);
      const amount = numericOperand(expression.amount);
      const wholeAmount =
        amount && amount.currency === undefined
          ? rationalToSafeWholeNumber(amount.value)
          : undefined;
      if (amount?.currency !== undefined) evaluationIssue = "money_dimension_mismatch";
      if (dateField && typeof dateValue === "string" && wholeAmount !== undefined)
        calculated = offsetDateValue(
          dateValue,
          wholeAmount,
          expression.unit,
          resultType(dateField) === "date_time",
        );
      if (
        dateField &&
        dateValue !== undefined &&
        amount !== undefined &&
        evaluationIssue === undefined &&
        calculated === undefined
      )
        evaluationIssue = "invalid_result";
    } else {
      const dueField = fields.get(expression.dueFieldId);
      const dueValue = values.get(expression.dueFieldId);
      const statusValue = expression.statusFieldId
        ? values.get(expression.statusFieldId)
        : undefined;
      const terminal =
        statusValue !== undefined && expression.terminalStatusValues.includes(statusValue);
      if (terminal) calculated = false;
      else if (typeof dueValue === "string" && dueField) {
        if (resultType(dueField) === "date")
          calculated = input.clock.organizationLocalDate > dueValue;
        if (resultType(dueField) === "date_time")
          calculated = compareInstants(operationInstant, exactInstant(dueValue)!) >= 0;
      }
    }

    if (evaluationIssue !== undefined) {
      issues.push(issue(evaluationIssue, field.fieldId));
      continue;
    }
    if (calculated === undefined) {
      if (
        (expression.kind === "numeric" || expression.kind === "subtract_percentage") &&
        field.settings.resultType === "whole_number" &&
        calculationDependencies(expression).every((fieldId) => values.has(fieldId))
      )
        issues.push(issue("non_integral_whole_number", field.fieldId));
      else missing(field);
      continue;
    }
    if (
      !persistedRecordFieldValueMatches({
        validationContractVersion: "2.0.0",
        field,
        value: calculated,
      })
    ) {
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
