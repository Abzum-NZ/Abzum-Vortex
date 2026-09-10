import {
  jsonValueSchema,
  moneyValueV2Schema,
  recordTypeDefinitionV2Schema,
  type ConditionNode,
  type JsonValue,
  type ModuleFieldV2,
  type RecordTypeDefinitionV2,
} from "@vortex/contracts";
import { evaluateTypedConditionV2 } from "@vortex/rule";
import {
  addRationals,
  compareRationals,
  divideRationals,
  rationalFromExactText,
  rationalFromWholeNumber,
  rationalToExactText,
  rationalToSafeWholeNumber,
  roundRationalHalfEven,
  type ExactRational,
} from "./exact-arithmetic";
import { persistedRecordFieldValueMatches } from "./field-values";

type TotalFieldV2 = Extract<ModuleFieldV2, { type: "total" }>;

export type RecordRelationshipTotalSourceV2 = Readonly<{
  relationshipId: string;
  sourceRecordType: RecordTypeDefinitionV2;
  records: readonly Readonly<{ fieldValues: Readonly<Record<string, unknown>> }>[];
}>;

export type EvaluateRecordTotalsV2Input = Readonly<{
  recordType: RecordTypeDefinitionV2;
  relationshipSources: readonly RecordRelationshipTotalSourceV2[];
}>;

export type RecordTotalIssueCode =
  | "invalid_input"
  | "execution_ineligible"
  | "invalid_source_value"
  | "condition_refused"
  | "mixed_currency"
  | "money_dimension_mismatch"
  | "non_integral_whole_number"
  | "required_result_missing"
  | "invalid_result";

export type RecordTotalIssue = Readonly<{
  code: RecordTotalIssueCode;
  fieldId?: string;
  path: readonly (string | number)[];
  /** Internal diagnostic only. A caller-facing save result must omit these codes. */
  currencyCodes?: readonly string[];
}>;

export type EvaluateRecordTotalsV2Result =
  | Readonly<{
      success: true;
      setValues: Readonly<Record<string, JsonValue>>;
      clearFieldIds: readonly string[];
    }>
  | Readonly<{
      success: false;
      issues: readonly RecordTotalIssue[];
    }>;

type ParsedRelationshipSource = Readonly<{
  sourceRecordType: RecordTypeDefinitionV2;
  records: readonly Readonly<{ fieldValues: Readonly<Record<string, unknown>> }>[];
}>;

type NumericValue = Readonly<{
  amount: ExactRational;
  currency?: string;
}>;

const issue = (
  code: RecordTotalIssueCode,
  fieldId?: string,
  path: readonly (string | number)[] = ["recordType"],
  currencyCodes?: readonly string[],
): RecordTotalIssue => ({
  code,
  ...(fieldId === undefined ? {} : { fieldId }),
  path,
  ...(currencyCodes === undefined ? {} : { currencyCodes }),
});

const isValueMap = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const fieldResultType = (field: ModuleFieldV2 | undefined): string | undefined =>
  field?.type === "calculation" || field?.type === "total"
    ? field.settings.resultType
    : field?.type;

const conditionFieldIds = (condition: ConditionNode): string[] => {
  const result: string[] = [];
  const seen = new Set<string>();
  const visit = (entry: ConditionNode): void => {
    if (entry.kind === "comparison") {
      for (const operand of [entry.left, entry.right])
        if (operand?.source === "field" && !seen.has(operand.fieldId)) {
          seen.add(operand.fieldId);
          result.push(operand.fieldId);
        }
      return;
    }
    if (entry.kind === "not") visit(entry.condition);
    else entry.conditions.forEach(visit);
  };
  visit(condition);
  return result;
};

const codePointCompare = (left: string, right: string): number => {
  const leftPoints = [...left].map((entry) => entry.codePointAt(0)!);
  const rightPoints = [...right].map((entry) => entry.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
};

const instantParts = (value: unknown): { seconds: number; fraction: string } | undefined => {
  if (typeof value !== "string") return undefined;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const local = new Date(0);
  local.setUTCHours(hour, minute, second, 0);
  local.setUTCFullYear(year, month - 1, day);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day
  )
    return undefined;
  const zone = match[8]!;
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetRemainder = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetRemainder > 59) return undefined;
    offsetMinutes = (offsetHours * 60 + offsetRemainder) * (zone[0] === "+" ? 1 : -1);
  }
  return {
    seconds: local.getTime() / 1_000 - offsetMinutes * 60,
    fraction: match[7] ?? "",
  };
};

const numericValue = (field: ModuleFieldV2, value: JsonValue): NumericValue | undefined => {
  const type = fieldResultType(field);
  if (type === "whole_number") {
    const amount = rationalFromWholeNumber(value);
    return amount === undefined ? undefined : { amount };
  }
  if (type === "decimal_number") {
    const amount = rationalFromExactText(value);
    return amount === undefined ? undefined : { amount };
  }
  if (type === "money") {
    const parsed = moneyValueV2Schema.safeParse(value);
    if (!parsed.success) return undefined;
    const amount = rationalFromExactText(parsed.data.amount);
    return amount === undefined ? undefined : { amount, currency: parsed.data.currency };
  }
  return undefined;
};

const sourceCompatible = (field: TotalFieldV2, sourceField: ModuleFieldV2 | undefined): boolean => {
  const sourceType = fieldResultType(sourceField);
  if (field.settings.operation === "count") return sourceField === undefined;
  if (sourceField === undefined) return false;
  if (field.settings.operation === "average")
    return (
      ["whole_number", "decimal_number", "money"].includes(sourceType ?? "") &&
      field.settings.resultType === (sourceType === "money" ? "money" : "decimal_number") &&
      field.settings.decimalPlaces !== undefined
    );
  if (
    field.settings.operation === "sum" &&
    !["whole_number", "decimal_number", "money"].includes(sourceType ?? "")
  )
    return false;
  return field.settings.resultType === sourceType;
};

const relationshipReaches = (
  sourceRecordType: RecordTypeDefinitionV2,
  relationshipId: string,
  targetRecordTypeId: string,
): boolean => {
  const relationship = sourceRecordType.relationships.find(
    (candidate) => candidate.relationshipId === relationshipId,
  );
  if (!relationship || relationship.fromRecordTypeId !== sourceRecordType.recordTypeId)
    return false;
  const targets = relationship.toRecordType
    ? [relationship.toRecordType]
    : (relationship.toRecordTypes ?? []);
  return targets.some(
    (target) => target.state === "resolved" && target.recordTypeId === targetRecordTypeId,
  );
};

const compareValues = (
  resultType: TotalFieldV2["settings"]["resultType"],
  left: JsonValue,
  right: JsonValue,
  sourceField: ModuleFieldV2,
): number | undefined => {
  if (resultType === "whole_number" || resultType === "decimal_number") {
    const leftNumber = numericValue(sourceField, left);
    const rightNumber = numericValue(sourceField, right);
    return leftNumber && rightNumber
      ? compareRationals(leftNumber.amount, rightNumber.amount)
      : undefined;
  }
  if (resultType === "money") {
    const leftMoney = numericValue(sourceField, left);
    const rightMoney = numericValue(sourceField, right);
    return leftMoney && rightMoney
      ? compareRationals(leftMoney.amount, rightMoney.amount)
      : undefined;
  }
  if (resultType === "yes_no")
    return typeof left === "boolean" && typeof right === "boolean"
      ? Number(left) - Number(right)
      : undefined;
  if (resultType === "date_time") {
    const leftInstant = instantParts(left);
    const rightInstant = instantParts(right);
    if (leftInstant === undefined || rightInstant === undefined) return undefined;
    const secondsOrder = leftInstant.seconds - rightInstant.seconds;
    if (secondsOrder !== 0) return secondsOrder;
    const precision = Math.max(leftInstant.fraction.length, rightInstant.fraction.length);
    const fractionOrder = codePointCompare(
      leftInstant.fraction.padEnd(precision, "0"),
      rightInstant.fraction.padEnd(precision, "0"),
    );
    return fractionOrder || codePointCompare(left as string, right as string);
  }
  return typeof left === "string" && typeof right === "string"
    ? codePointCompare(left, right)
    : undefined;
};

const totalResult = (
  field: TotalFieldV2,
  sourceField: ModuleFieldV2 | undefined,
  values: readonly JsonValue[],
): Readonly<{ value?: JsonValue; issue?: RecordTotalIssue }> => {
  const { operation, resultType } = field.settings;
  if (operation === "count") return { value: values.length };
  if (!sourceField) return { issue: issue("execution_ineligible", field.fieldId) };
  if (values.length === 0) {
    if (operation !== "sum") return {};
    if (resultType === "whole_number") return { value: 0 };
    if (resultType === "decimal_number") return { value: "0" };
    return field.settings.currency === undefined
      ? {}
      : { value: { amount: "0", currency: field.settings.currency } };
  }

  const numericValues = values.map((value) => numericValue(sourceField, value));
  if (["sum", "average"].includes(operation) && numericValues.some((value) => !value))
    return { issue: issue("invalid_source_value", field.fieldId) };
  const currencies = [
    ...new Set(numericValues.flatMap((value) => (value?.currency ? [value.currency] : []))),
  ].sort(codePointCompare);
  if (resultType === "money" && currencies.length > 1)
    return { issue: issue("mixed_currency", field.fieldId, ["relationshipSources"], currencies) };
  if (
    resultType === "money" &&
    field.settings.currency !== undefined &&
    (currencies.length !== 1 || currencies[0] !== field.settings.currency)
  )
    return { issue: issue("money_dimension_mismatch", field.fieldId) };

  if (operation === "sum" || operation === "average") {
    const parsed = numericValues as NumericValue[];
    const sum = parsed
      .slice(1)
      .reduce((current, value) => addRationals(current, value.amount), parsed[0]!.amount);
    const result =
      operation === "average"
        ? divideRationals(sum, rationalFromWholeNumber(parsed.length)!)!
        : sum;
    if (resultType === "whole_number") {
      const whole = rationalToSafeWholeNumber(result);
      return whole === undefined
        ? { issue: issue("non_integral_whole_number", field.fieldId) }
        : { value: whole };
    }
    const amount =
      operation === "average"
        ? roundRationalHalfEven(result, field.settings.decimalPlaces!)
        : rationalToExactText(result);
    if (amount === undefined) return { issue: issue("invalid_result", field.fieldId) };
    return resultType === "money"
      ? { value: { amount, currency: currencies[0]! } }
      : { value: amount };
  }

  let selected: JsonValue = values[0]!;
  for (const value of values.slice(1)) {
    const comparison = compareValues(resultType, selected, value, sourceField);
    if (comparison === undefined) return { issue: issue("invalid_source_value", field.fieldId) };
    if ((operation === "minimum" && comparison > 0) || (operation === "maximum" && comparison < 0))
      selected = value;
  }
  return { value: selected };
};

/**
 * Evaluates canonical Module V2 totals over supplied related values. It performs
 * no reads, writes, access checks or authoritative-source selection.
 */
export const evaluateRecordTotalsV2 = (
  input: EvaluateRecordTotalsV2Input,
): EvaluateRecordTotalsV2Result => {
  const parsedTarget = recordTypeDefinitionV2Schema.safeParse(input.recordType);
  if (!parsedTarget.success || !Array.isArray(input.relationshipSources))
    return { success: false, issues: [issue("invalid_input")] };

  const target = parsedTarget.data;
  const totals = target.fields.filter((field): field is TotalFieldV2 => field.type === "total");
  const requiredRelationships = new Set(totals.map((field) => field.settings.relationshipId));
  const sources = new Map<string, ParsedRelationshipSource>();
  for (const [sourceIndex, candidate] of input.relationshipSources.entries()) {
    const parsedSource = recordTypeDefinitionV2Schema.safeParse(candidate?.sourceRecordType);
    if (
      !candidate ||
      typeof candidate.relationshipId !== "string" ||
      sources.has(candidate.relationshipId) ||
      !requiredRelationships.has(candidate.relationshipId) ||
      !parsedSource.success ||
      !Array.isArray(candidate.records) ||
      candidate.records.some(
        (record: Readonly<{ fieldValues: Readonly<Record<string, unknown>> }>) =>
          !isValueMap(record?.fieldValues),
      ) ||
      !relationshipReaches(parsedSource.data, candidate.relationshipId, target.recordTypeId)
    )
      return {
        success: false,
        issues: [issue("invalid_input", undefined, ["relationshipSources", sourceIndex])],
      };
    sources.set(candidate.relationshipId, {
      sourceRecordType: parsedSource.data,
      records: candidate.records,
    });
  }
  if ([...requiredRelationships].some((relationshipId) => !sources.has(relationshipId)))
    return {
      success: false,
      issues: [issue("invalid_input", undefined, ["relationshipSources"])],
    };

  const setValues: Record<string, JsonValue> = {};
  const clearFieldIds: string[] = [];
  const issues: RecordTotalIssue[] = [];
  for (const field of totals) {
    const source = sources.get(field.settings.relationshipId)!;
    const sourceFields = new Map<string, ModuleFieldV2>(
      source.sourceRecordType.fields.map((candidate) => [candidate.fieldId, candidate]),
    );
    const aggregateField =
      field.settings.fieldId === undefined ? undefined : sourceFields.get(field.settings.fieldId);
    if (
      !sourceCompatible(field, aggregateField) ||
      (field.settings.currency !== undefined &&
        (field.settings.operation !== "sum" || fieldResultType(aggregateField) !== "money"))
    ) {
      issues.push(issue("execution_ineligible", field.fieldId));
      continue;
    }

    const filterFieldIds = field.settings.filter ? conditionFieldIds(field.settings.filter) : [];
    if (filterFieldIds.some((fieldId) => !sourceFields.has(fieldId))) {
      issues.push(issue("execution_ineligible", field.fieldId));
      continue;
    }
    const includedValues: JsonValue[] = [];
    let fieldIssue: RecordTotalIssue | undefined;
    for (const [recordIndex, record] of source.records.entries()) {
      const unknownField = Object.keys(record.fieldValues).find(
        (fieldId) => !sourceFields.has(fieldId),
      );
      if (unknownField !== undefined) {
        fieldIssue = issue("invalid_input", field.fieldId, [
          "relationshipSources",
          field.settings.relationshipId,
          "records",
          recordIndex,
          "fieldValues",
          unknownField,
        ]);
        break;
      }
      for (const fieldId of filterFieldIds) {
        const value = record.fieldValues[fieldId];
        if (value === undefined || value === null) continue;
        const sourceField = sourceFields.get(fieldId)!;
        if (
          !jsonValueSchema.safeParse(value).success ||
          !persistedRecordFieldValueMatches({
            validationContractVersion: "2.0.0",
            field: sourceField,
            value,
          })
        ) {
          fieldIssue = issue("invalid_source_value", field.fieldId, [
            "relationshipSources",
            field.settings.relationshipId,
            "records",
            recordIndex,
            "fieldValues",
            fieldId,
          ]);
          break;
        }
      }
      if (fieldIssue) break;
      if (field.settings.filter) {
        const filterValues = Object.fromEntries(
          filterFieldIds.map((fieldId) => [fieldId, record.fieldValues[fieldId] ?? null]),
        );
        try {
          if (
            !evaluateTypedConditionV2({
              condition: field.settings.filter,
              sourceRecordFields: source.sourceRecordType.fields,
              declaredFieldIds: filterFieldIds,
              parameterDeclarations: [],
              fieldValues: filterValues,
              parameterValues: {},
            })
          )
            continue;
        } catch {
          fieldIssue = issue("condition_refused", field.fieldId);
          break;
        }
      }
      if (field.settings.operation === "count") includedValues.push(null);
      else {
        const value = record.fieldValues[aggregateField!.fieldId];
        if (value !== undefined && value !== null) {
          if (
            !jsonValueSchema.safeParse(value).success ||
            !persistedRecordFieldValueMatches({
              validationContractVersion: "2.0.0",
              field: aggregateField!,
              value,
            })
          ) {
            fieldIssue = issue("invalid_source_value", field.fieldId, [
              "relationshipSources",
              field.settings.relationshipId,
              "records",
              recordIndex,
              "fieldValues",
              aggregateField!.fieldId,
            ]);
            break;
          }
          includedValues.push(value as JsonValue);
        }
      }
    }
    if (fieldIssue) {
      issues.push(fieldIssue);
      continue;
    }

    const evaluated = totalResult(field, aggregateField, includedValues);
    if (evaluated.issue) {
      issues.push(evaluated.issue);
      continue;
    }
    if (evaluated.value === undefined) {
      if (field.required) issues.push(issue("required_result_missing", field.fieldId));
      else clearFieldIds.push(field.fieldId);
      continue;
    }
    if (
      !jsonValueSchema.safeParse(evaluated.value).success ||
      !persistedRecordFieldValueMatches({
        validationContractVersion: "2.0.0",
        field,
        value: evaluated.value,
      })
    ) {
      issues.push(issue("invalid_result", field.fieldId));
      continue;
    }
    setValues[field.fieldId] = evaluated.value;
  }

  return issues.length > 0
    ? { success: false, issues }
    : { success: true, setValues, clearFieldIds };
};
