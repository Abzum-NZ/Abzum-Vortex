import { jsonValueSchema, type JsonValue } from "../catalogue/common";
import {
  builderKeySchema,
  fieldIdSchema,
  organizationAccountIdSchema,
} from "../catalogue/identifiers";
import { isRecord } from "../catalogue/runtime-primitives";
import { moduleFieldSchema, type ModuleField } from "../definition/module-contracts";
import { conditionNodeSchema, type ConditionNode } from "../definition/module-foundation-contracts";
import {
  TypedConditionEvaluationError,
  type TypedConditionEvaluationErrorReason,
} from "./typed-condition-error";
import {
  evaluateResolvedTypedCondition,
  semanticTypeForField,
  valueMatchesField,
  valueMatchesSemanticType,
  type ResolvedTypedConditionOperand,
} from "./typed-condition-semantics";

export type TypedConditionParameterDeclaration = Readonly<{
  key: string;
  type:
    | "text"
    | "whole_number"
    | "decimal_number"
    | "money"
    | "yes_no"
    | "date"
    | "date_time"
    | "record_reference"
    | "organization_account_reference";
}>;

export type TypedConditionEvaluationInput = Readonly<{
  condition: ConditionNode;
  sourceRecordFields: readonly ModuleField[];
  declaredFieldIds: readonly string[];
  parameterDeclarations: readonly TypedConditionParameterDeclaration[];
  fieldValues: Readonly<Record<string, unknown>>;
  parameterValues: Readonly<Record<string, unknown>>;
}>;

const parameterTypes = new Set<TypedConditionParameterDeclaration["type"]>([
  "record_reference",
  "text",
  "whole_number",
  "decimal_number",
  "money",
  "yes_no",
  "date",
  "date_time",
  "organization_account_reference",
]);

const supportedOperators = new Set([
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "in",
  "not_in",
  "greater_than",
  "greater_than_or_equal",
  "less_than",
  "less_than_or_equal",
  "is_empty",
  "is_not_empty",
]);

const refuse = (reason: TypedConditionEvaluationErrorReason): never => {
  throw new TypedConditionEvaluationError(reason);
};

const hasOwn = (value: Readonly<Record<string, unknown>>, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

const sameKeys = (actual: readonly string[], expected: ReadonlySet<string>) =>
  actual.length === expected.size && actual.every((key) => expected.has(key));

const containsUnsupportedOperator = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (value.kind === "comparison")
    return typeof value.operator === "string" && !supportedOperators.has(value.operator);
  if ((value.kind === "all" || value.kind === "any") && Array.isArray(value.conditions))
    return value.conditions.some(containsUnsupportedOperator);
  return value.kind === "not" && containsUnsupportedOperator(value.condition);
};

const valueMatchesParameter = (
  value: JsonValue,
  type: TypedConditionParameterDeclaration["type"],
): boolean =>
  type === "organization_account_reference"
    ? organizationAccountIdSchema.safeParse(value).success
    : valueMatchesSemanticType(value, type);

/** Evaluates canonical Module  conditions without coercing exact values through Number. */
export function evaluateTypedCondition(input: TypedConditionEvaluationInput): boolean {
  const candidateInput = input as unknown;
  if (
    !isRecord(candidateInput) ||
    !Array.isArray(candidateInput.sourceRecordFields) ||
    !Array.isArray(candidateInput.declaredFieldIds) ||
    !Array.isArray(candidateInput.parameterDeclarations) ||
    !isRecord(candidateInput.fieldValues) ||
    !isRecord(candidateInput.parameterValues)
  )
    refuse("input_refused");
  const safeInput = candidateInput as unknown as TypedConditionEvaluationInput;
  const parsedCondition = conditionNodeSchema.safeParse(safeInput.condition);
  if (!parsedCondition.success)
    refuse(containsUnsupportedOperator(safeInput.condition) ? "operator_refused" : "input_refused");

  const parsedFields = safeInput.sourceRecordFields.map((field) =>
    moduleFieldSchema.safeParse(field),
  );
  if (parsedFields.some((field) => !field.success)) refuse("input_refused");
  const fields: ModuleField[] = [];
  for (const parsedField of parsedFields) {
    if (!parsedField.success) refuse("input_refused");
    fields.push(parsedField.data!);
  }
  const fieldIds = fields.map((field) => field.fieldId);
  if (new Set(fieldIds).size !== fieldIds.length) refuse("input_refused");
  const fieldsById = new Map<string, ModuleField>(fields.map((field) => [field.fieldId, field]));

  const declaredFieldIds = safeInput.declaredFieldIds.map((fieldId) => {
    const parsed = fieldIdSchema.safeParse(fieldId);
    if (!parsed.success) refuse("field_refused");
    return parsed.data!;
  });
  if (
    new Set(declaredFieldIds).size !== declaredFieldIds.length ||
    declaredFieldIds.some((fieldId) => !fieldsById.has(fieldId))
  )
    refuse("field_refused");
  const declaredFields = new Set<string>(declaredFieldIds);

  if (
    safeInput.parameterDeclarations.some(
      (parameter) =>
        !isRecord(parameter) || !sameKeys(Object.keys(parameter), new Set(["key", "type"])),
    )
  )
    refuse("parameter_refused");
  const parameterDeclarations =
    safeInput.parameterDeclarations as readonly TypedConditionParameterDeclaration[];
  const parameterKeys = parameterDeclarations.map((parameter) => parameter.key);
  if (
    new Set(parameterKeys).size !== parameterKeys.length ||
    parameterDeclarations.some(
      (parameter) =>
        !builderKeySchema.safeParse(parameter.key).success || !parameterTypes.has(parameter.type),
    )
  )
    refuse("parameter_refused");
  const declaredParameterTypes = new Map(
    parameterDeclarations.map((parameter) => [parameter.key, parameter.type] as const),
  );

  const suppliedFieldIds = Object.keys(safeInput.fieldValues);
  if (!sameKeys(suppliedFieldIds, declaredFields)) refuse("input_refused");
  const canonicalFieldValues = new Map<string, JsonValue>();
  for (const [fieldId, value] of Object.entries(safeInput.fieldValues)) {
    const field = fieldsById.get(fieldId);
    if (
      !declaredFields.has(fieldId) ||
      !field ||
      !jsonValueSchema.safeParse(value).success ||
      !valueMatchesField(value as JsonValue, field)
    )
      refuse("input_refused");
    canonicalFieldValues.set(fieldId, value as JsonValue);
  }

  if (!sameKeys(Object.keys(safeInput.parameterValues), new Set(parameterKeys)))
    refuse("input_refused");
  for (const [key, value] of Object.entries(safeInput.parameterValues)) {
    const type = declaredParameterTypes.get(key);
    if (
      !type ||
      value === null ||
      !jsonValueSchema.safeParse(value).success ||
      !valueMatchesParameter(value as JsonValue, type)
    )
      refuse("input_refused");
  }

  const operand = (entry: unknown): ResolvedTypedConditionOperand => {
    const value = entry as { source: string; fieldId?: string; key?: string; value?: JsonValue };
    if (value.source === "field") {
      const fieldId = String(value.fieldId);
      const field = fieldsById.get(fieldId);
      if (!declaredFields.has(fieldId) || !field || !canonicalFieldValues.has(fieldId))
        refuse("field_refused");
      const declaredField = field ?? refuse("field_refused");
      return {
        type: semanticTypeForField(declaredField),
        value: canonicalFieldValues.get(fieldId)!,
      };
    }
    if (value.source === "parameter") {
      const key = String(value.key);
      const type = declaredParameterTypes.get(key);
      if (!type || !hasOwn(safeInput.parameterValues, key)) refuse("parameter_refused");
      const declaredType = type ?? refuse("parameter_refused");
      return { type: declaredType, value: safeInput.parameterValues[key] as JsonValue };
    }
    if (value.source !== "value" || !jsonValueSchema.safeParse(value.value).success)
      refuse("input_refused");
    return { literal: value.value as JsonValue, value: value.value as JsonValue };
  };

  return evaluateResolvedTypedCondition(parsedCondition.data!, operand);
}
