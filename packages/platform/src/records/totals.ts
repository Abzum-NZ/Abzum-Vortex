import { jsonValueSchema, type JsonValue } from "../catalogue/common";
import {
  recordTypeDefinitionSchema,
  type ModuleField,
  type RecordTypeDefinition,
} from "../definition/module-contracts";
import type { ConditionNode } from "../definition/module-foundation-contracts";
import type { FlowFormula } from "../workflows/flow-values";
import { moneyValueSchema } from "./module-field-values";
import { compareFlowText, evaluateFlowFormula } from "../rules/flow-formula";
import { evaluateTypedCondition } from "../rules/typed-condition";
import { persistedRecordFieldValueMatches } from "./field-values";

type TotalField = Extract<ModuleField, { type: "total" }>;

export type RecordRelationshipTotalSource = Readonly<{
  relationshipId: string;
  sourceRecordType: RecordTypeDefinition;
  records: readonly Readonly<{ fieldValues: Readonly<Record<string, unknown>> }>[];
}>;

export type EvaluateRecordTotalsInput = Readonly<{
  recordType: RecordTypeDefinition;
  relationshipSources: readonly RecordRelationshipTotalSource[];
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

export type EvaluateRecordTotalsResult =
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
  sourceRecordType: RecordTypeDefinition;
  records: readonly Readonly<{ fieldValues: Readonly<Record<string, unknown>> }>[];
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

const isValueMap = (candidate: unknown): candidate is Readonly<Record<string, unknown>> =>
  candidate !== null && typeof candidate === "object" && !Array.isArray(candidate);

const fieldResultType = (field: ModuleField | undefined): string | undefined =>
  field?.type === "calculation" || field?.type === "total"
    ? field.settings.resultType
    : field?.type;

const formulaTypeOf = (field: ModuleField): string => {
  const type = fieldResultType(field);
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
      return type ?? "json";
  }
};

const literal = (type: string, value: JsonValue): FlowFormula =>
  ({ op: "literal", type, value }) as unknown as FlowFormula;

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

const currenciesOf = (field: ModuleField, values: readonly JsonValue[]): string[] => {
  if (fieldResultType(field) !== "money") return [];
  return [
    ...new Set(
      values.flatMap((value) => {
        const parsed = moneyValueSchema.safeParse(value);
        return parsed.success ? [parsed.data.currency] : [];
      }),
    ),
  ].sort(compareFlowText);
};

const sourceCompatible = (field: TotalField, sourceField: ModuleField | undefined): boolean => {
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
  sourceRecordType: RecordTypeDefinition,
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

const evaluateFormula = (formula: FlowFormula) =>
  evaluateFlowFormula(
    formula,
    {
      now: "1970-01-01T00:00:00.000Z",
      reference: () => undefined,
    },
    { preserveExactArithmetic: true },
  );

const sumFormula = (operands: readonly FlowFormula[], scale: number): FlowFormula => {
  if (operands.length === 1) return operands[0]!;
  if (operands.length <= 10)
    return { op: "add", args: [...operands], scale, rounding: "half_even" };
  const groups: FlowFormula[] = [];
  for (let index = 0; index < operands.length; index += 10)
    groups.push(sumFormula(operands.slice(index, index + 10), scale));
  return sumFormula(groups, scale);
};

/**
 * A total over no related records: a count and a sum are zero (a sum of money only in its own
 * currency), and the other operations have no value.
 */
const emptyTotal = (field: TotalField): JsonValue | undefined => {
  const { operation, resultType } = field.settings;
  if (operation === "count") return 0;
  if (operation !== "sum") return undefined;
  if (resultType === "whole_number") return 0;
  if (resultType === "decimal_number") return "0";
  return field.settings.currency === undefined
    ? undefined
    : { amount: "0", currency: field.settings.currency };
};

/**
 * The totals of a record no related record links to yet, such as a record being created: the
 * values its total fields start with.
 */
export const emptyRecordTotals = (
  recordType: RecordTypeDefinition,
): Readonly<Record<string, JsonValue>> => {
  const values: Record<string, JsonValue> = {};
  for (const field of recordType.fields) {
    if (field.type !== "total") continue;
    const value = emptyTotal(field);
    if (value !== undefined) values[field.fieldId] = value;
  }
  return values;
};

const totalResult = (
  field: TotalField,
  sourceField: ModuleField | undefined,
  values: readonly JsonValue[],
): Readonly<{ value?: JsonValue; issue?: RecordTotalIssue }> => {
  const { operation, resultType } = field.settings;
  if (operation === "count") return { value: values.length };
  if (!sourceField) return { issue: issue("execution_ineligible", field.fieldId) };
  if (values.length === 0) {
    const value = emptyTotal(field);
    return value === undefined ? {} : { value };
  }

  const currencies = currenciesOf(sourceField, values);
  if (resultType === "money" && currencies.length > 1)
    return {
      issue: issue("mixed_currency", field.fieldId, ["relationshipSources"], currencies),
    };
  if (
    resultType === "money" &&
    field.settings.currency !== undefined &&
    (currencies.length !== 1 || currencies[0] !== field.settings.currency)
  )
    return { issue: issue("money_dimension_mismatch", field.fieldId) };

  const sourceType = formulaTypeOf(sourceField);
  const operands = values.map((value) => literal(sourceType, value));
  if (operation === "minimum" || operation === "maximum") {
    let selected: JsonValue = values[0]!;
    for (const candidate of values.slice(1)) {
      if (sourceType === "yes_no") {
        const combined = evaluateFormula({
          op: operation === "minimum" ? "and" : "or",
          args: [literal(sourceType, candidate), literal(sourceType, selected)],
        });
        if (combined?.type !== "yes_no" || typeof combined.value !== "boolean")
          return { issue: issue("invalid_source_value", field.fieldId) };
        selected = combined.value;
        continue;
      }
      const comparison = evaluateFormula({
        op: operation === "minimum" ? "lt" : "gt",
        left: literal(sourceType, candidate),
        right: literal(sourceType, selected),
      });
      if (comparison?.type !== "yes_no" || typeof comparison.value !== "boolean")
        return { issue: issue("invalid_source_value", field.fieldId) };
      if (comparison.value) selected = candidate;
      else if (
        sourceType === "date_time" &&
        typeof candidate === "string" &&
        typeof selected === "string" &&
        evaluateFormula({
          op: "eq",
          left: literal(sourceType, candidate),
          right: literal(sourceType, selected),
        })?.value === true &&
        (operation === "minimum"
          ? compareFlowText(candidate, selected) < 0
          : compareFlowText(candidate, selected) > 0)
      )
        selected = candidate;
    }
    return { value: selected };
  }

  const sumScale = resultType === "whole_number" ? 0 : 18;
  const sum =
    operation === "sum" && operands.length === 1
      ? sumFormula(
          [
            operands[0]!,
            literal(
              sourceType,
              sourceType === "money"
                ? { amount: "0", currency: currencies[0]! }
                : sourceType === "whole_number"
                  ? 0
                  : "0",
            ),
          ],
          sumScale,
        )
      : sumFormula(operands, sumScale);
  const evaluated = evaluateFormula(
    operation === "average"
      ? {
          op: "divide",
          args: [sum, literal("whole_number", values.length)],
          scale: field.settings.decimalPlaces!,
          rounding: "half_even",
        }
      : sum,
  );
  if (evaluated === undefined) {
    return {
      issue:
        resultType === "whole_number"
          ? issue("non_integral_whole_number", field.fieldId)
          : issue("invalid_result", field.fieldId),
    };
  }
  if (resultType === "whole_number") {
    const whole = Number(evaluated.value);
    return Number.isSafeInteger(whole)
      ? { value: whole }
      : { issue: issue("non_integral_whole_number", field.fieldId) };
  }
  return { value: evaluated.value };
};

/**
 * Aggregates authoritative related values through the shared flow formula evaluator.
 * It performs no reads, writes, access checks or authoritative-source selection.
 */
export const evaluateRecordTotals = (
  input: EvaluateRecordTotalsInput,
): EvaluateRecordTotalsResult => {
  const parsedTarget = recordTypeDefinitionSchema.safeParse(input.recordType);
  if (!parsedTarget.success || !Array.isArray(input.relationshipSources))
    return { success: false, issues: [issue("invalid_input")] };

  const target = parsedTarget.data;
  const totals = target.fields.filter((field): field is TotalField => field.type === "total");
  const requiredRelationships = new Set(totals.map((field) => field.settings.relationshipId));
  const sources = new Map<string, ParsedRelationshipSource>();
  for (const [sourceIndex, candidate] of input.relationshipSources.entries()) {
    const parsedSource = recordTypeDefinitionSchema.safeParse(candidate?.sourceRecordType);
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
    const sourceFields = new Map<string, ModuleField>(
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
            !evaluateTypedCondition({
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
