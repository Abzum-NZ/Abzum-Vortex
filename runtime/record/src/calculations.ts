import {
  jsonValueSchema,
  moneyValueV2Schema,
  recordTypeDefinitionV3Schema,
  timestampSchema,
  type JsonValue,
  type ModuleFieldV3,
  type RecordTypeDefinitionV3,
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

type CalculationFieldV2 = Extract<ModuleFieldV3, { type: "calculation" }>;
type CalculationExpressionV2 = CalculationFieldV2["settings"]["expression"];
/** One value of a numeric calculation: a named field, an exact literal, or a nested operation. */
type CalculationNumberValueV2 = Extract<
  CalculationExpressionV2,
  { kind: "numeric" }
>["operands"][number];
type CalculationNumberLeafV2 = Extract<CalculationNumberValueV2, { source: "field" | "literal" }>;

export type RecordCalculationClockV2 = Readonly<{
  instant: string;
  organizationLocalDate: string;
}>;

export type EvaluateRecordCalculationsV2Input = Readonly<{
  recordType: RecordTypeDefinitionV3;
  authoritativeFieldValues: Readonly<Record<string, unknown>>;
  clock: RecordCalculationClockV2;
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

type NumberRefusalCode = Extract<
  RecordCalculationIssueCode,
  "division_by_zero" | "money_dimension_mismatch" | "result_overflow"
>;
/**
 * One numeric value of a calculation: absent when a named operand has no usable value, refused
 * when the arithmetic or the money dimensions of one operation are not allowed, and otherwise
 * the exact rational with the currency its dimensions require. A nested operation is worked out
 * with the same rules as the calculation that contains it, so only the outermost result is
 * checked against the declared result type.
 */
type NumberValueOutcome =
  | { kind: "value"; value: NumericValue }
  | { kind: "absent" }
  | { kind: "refused"; code: NumberRefusalCode };

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

const numberValueDependencies = (
  value: CalculationNumberValueV2,
  add: (fieldId: string) => void,
): void => {
  if (value.source === "numeric") {
    value.operands.forEach((operand) => numberValueDependencies(operand, add));
    return;
  }
  if (value.source === "field") add(value.fieldId);
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
      expression.operands.forEach((operand) => numberValueDependencies(operand, add));
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

const resultType = (field: ModuleFieldV3): string =>
  field.type === "calculation" || field.type === "total" ? field.settings.resultType : field.type;

const numericValue = (field: ModuleFieldV3, value: unknown): NumericValue | undefined => {
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

/**
 * True when an exact result is a whole number too large for the declared whole-number result
 * type. Such a result is refused outright rather than reported as a missing or fractional value,
 * because no exact value exists that the declared type can hold.
 */
const wholeNumberOverflows = (value: ExactRational): boolean =>
  value.numerator % value.denominator === 0n &&
  (value.numerator / value.denominator < BigInt(Number.MIN_SAFE_INTEGER) ||
    value.numerator / value.denominator > BigInt(Number.MAX_SAFE_INTEGER));

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
  const parsedRecordType = recordTypeDefinitionV3Schema.safeParse(input.recordType);
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
  const fields = new Map<string, ModuleFieldV3>(
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
  const numberLeaf = (leaf: CalculationNumberLeafV2): NumberValueOutcome => {
    let parsed: NumericValue | undefined;
    if (leaf.source === "literal") {
      const exact = rationalFromExactText(leaf.value);
      parsed = exact === undefined ? undefined : { value: exact };
    } else {
      const dependencyField = fields.get(leaf.fieldId);
      const dependencyValue = values.get(leaf.fieldId);
      parsed =
        dependencyField === undefined || dependencyValue === undefined
          ? undefined
          : numericValue(dependencyField, dependencyValue);
    }
    return parsed === undefined ? { kind: "absent" } : { kind: "value", value: parsed };
  };
  const numberValue = (value: CalculationNumberValueV2): NumberValueOutcome => {
    if (value.source !== "numeric") return numberLeaf(value);
    const numbers: NumericValue[] = [];
    let refused: { kind: "refused"; code: NumberRefusalCode } | undefined;
    for (const operand of value.operands) {
      const outcome = numberValue(operand);
      if (outcome.kind === "value") numbers.push(outcome.value);
      if (outcome.kind === "refused") refused ??= outcome;
    }
    // An unusable operand leaves the whole formula without a value, but an operation the closed
    // catalogue refuses is an authoring defect and is reported even beside an unusable operand.
    if (numbers.length !== value.operands.length) return refused ?? { kind: "absent" };
    const currency = sameCurrency(numbers);
    const moneyCount = numbers.filter((number) => number.currency !== undefined).length;
    const dimensionsValid =
      value.operation === "add" || value.operation === "subtract"
        ? moneyCount === 0 || (moneyCount === numbers.length && currency !== undefined)
        : value.operation === "multiply"
          ? moneyCount <= 1
          : moneyCount === 0 || (moneyCount === 1 && numbers[0]!.currency !== undefined);
    if (!dimensionsValid) return { kind: "refused", code: "money_dimension_mismatch" };
    let accumulated = numbers[0]!.value;
    for (const number of numbers.slice(1)) {
      if (value.operation === "add") accumulated = addRationals(accumulated, number.value);
      if (value.operation === "subtract")
        accumulated = subtractRationals(accumulated, number.value);
      if (value.operation === "multiply")
        accumulated = multiplyRationals(accumulated, number.value);
      if (value.operation === "divide") {
        const divided = divideRationals(accumulated, number.value);
        if (divided === undefined) return { kind: "refused", code: "division_by_zero" };
        accumulated = divided;
      }
    }
    return {
      kind: "value",
      value: { value: accumulated, ...(currency === undefined ? {} : { currency }) },
    };
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
      const outcome = numberValue(expression);
      if (outcome.kind === "refused") evaluationIssue = outcome.code;
      else if (outcome.kind === "value") {
        const resultIsMoney = outcome.value.currency !== undefined;
        if ((field.settings.resultType === "money") !== resultIsMoney)
          evaluationIssue = "money_dimension_mismatch";
        else if (
          field.settings.resultType === "whole_number" &&
          wholeNumberOverflows(outcome.value.value)
        )
          evaluationIssue = "result_overflow";
        else calculated = numericResult(field, outcome.value.value, outcome.value.currency);
      }
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
      const amountOutcome = numberLeaf(expression.amount);
      const amount = amountOutcome.kind === "value" ? amountOutcome.value : undefined;
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
        expression.kind === "numeric" &&
        field.settings.resultType === "whole_number" &&
        calculationDependencies(expression).every((fieldId) => values.has(fieldId))
      )
        issues.push(issue("non_integral_whole_number", field.fieldId));
      else missing(field);
      continue;
    }
    if (
      !persistedRecordFieldValueMatches({
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

const isReadTimeCalculationField = (field: CalculationFieldV2): boolean =>
  field.settings.evaluation === "read_time" || field.settings.expression.kind === "deadline_passed";

/**
 * The calculated fields of a record type that are worked out whenever a record
 * is read: those declared `read_time`, every deadline-passed calculation, and
 * every calculation that depends, through any chain, on one of those.
 */
export const readTimeCalculationFieldIdsV2 = (
  recordType: RecordTypeDefinitionV3,
): readonly string[] => {
  const calculations = recordType.fields.filter(
    (field): field is CalculationFieldV2 => field.type === "calculation",
  );
  const readTime = new Set<string>(
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

export type EvaluateReadTimeCalculationsV2Result =
  | Readonly<{
      success: true;
      /** The current value of every read-time field that has one; never stored. */
      values: Readonly<Record<string, JsonValue>>;
      /** Read-time fields that have no value now. */
      emptyFieldIds: readonly string[];
    }>
  | Readonly<{
      success: false;
      issues: readonly RecordCalculationIssue[];
    }>;

/**
 * Works out the read-time calculated fields of one record with the same typed
 * evaluator a save uses, from the record's stored values and one read clock:
 * the statement instant and the current date in the organisation's time zone.
 * The result is never written back. It performs no reads or access decisions.
 * A required read-time field with no value now (such as a deadline with no due
 * value) is reported empty, as the database read reports it, rather than
 * failing the read.
 */
export const evaluateReadTimeCalculationsV2 = (
  input: EvaluateRecordCalculationsV2Input,
): EvaluateReadTimeCalculationsV2Result => {
  const parsed = recordTypeDefinitionV3Schema.safeParse(input.recordType);
  if (!parsed.success) return { success: false, issues: [issue("invalid_input")] };
  const readTimeIds = new Set(readTimeCalculationFieldIdsV2(parsed.data));
  const evaluated = evaluateRecordCalculationsV2({
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
