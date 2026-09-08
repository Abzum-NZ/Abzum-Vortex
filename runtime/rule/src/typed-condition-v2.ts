import {
  builderKeySchema,
  conditionNodeSchema,
  fieldIdSchema,
  jsonValueSchema,
  moduleFieldV2Schema,
  organizationAccountIdSchema,
  type ConditionNode,
  type JsonValue,
  type ModuleFieldV2,
} from "@vortex/contracts";
import {
  TypedConditionEvaluationError,
  type TypedConditionEvaluationErrorReason,
} from "./typed-condition";
import {
  evaluateResolvedTypedConditionV2,
  semanticTypeForFieldV2,
  valueMatchesFieldV2,
  valueMatchesSemanticTypeV2,
  type ResolvedTypedConditionOperandV2,
} from "./typed-condition-v2-semantics";

export type TypedConditionParameterDeclarationV2 = Readonly<{
  key: string;
  type:
    | "text"
    | "number"
    | "decimal_number"
    | "money"
    | "boolean"
    | "date"
    | "date_time"
    | "organization_account_reference";
}>;

export type TypedConditionEvaluationInputV2 = Readonly<{
  condition: ConditionNode;
  sourceRecordFields: readonly ModuleFieldV2[];
  declaredFieldIds: readonly string[];
  parameterDeclarations: readonly TypedConditionParameterDeclarationV2[];
  fieldValues: Readonly<Record<string, unknown>>;
  parameterValues: Readonly<Record<string, unknown>>;
}>;

const parameterTypesV2 = new Set<TypedConditionParameterDeclarationV2["type"]>([
  "text",
  "number",
  "decimal_number",
  "money",
  "boolean",
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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

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
  type: TypedConditionParameterDeclarationV2["type"],
): boolean =>
  type === "organization_account_reference"
    ? organizationAccountIdSchema.safeParse(value).success
    : valueMatchesSemanticTypeV2(value, type);

/** Evaluates canonical Module V2 conditions without coercing exact values through Number. */
export function evaluateTypedConditionV2(input: TypedConditionEvaluationInputV2): boolean {
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
  const safeInput = candidateInput as unknown as TypedConditionEvaluationInputV2;
  const parsedCondition = conditionNodeSchema.safeParse(safeInput.condition);
  if (!parsedCondition.success)
    refuse(containsUnsupportedOperator(safeInput.condition) ? "operator_refused" : "input_refused");

  const parsedFields = safeInput.sourceRecordFields.map((field) =>
    moduleFieldV2Schema.safeParse(field),
  );
  if (parsedFields.some((field) => !field.success)) refuse("input_refused");
  const fields: ModuleFieldV2[] = [];
  for (const parsedField of parsedFields) {
    if (!parsedField.success) refuse("input_refused");
    fields.push(parsedField.data!);
  }
  const fieldIds = fields.map((field) => field.fieldId);
  if (new Set(fieldIds).size !== fieldIds.length) refuse("input_refused");
  const fieldsById = new Map<string, ModuleFieldV2>(fields.map((field) => [field.fieldId, field]));

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
    safeInput.parameterDeclarations as readonly TypedConditionParameterDeclarationV2[];
  const parameterKeys = parameterDeclarations.map((parameter) => parameter.key);
  if (
    new Set(parameterKeys).size !== parameterKeys.length ||
    parameterDeclarations.some(
      (parameter) =>
        !builderKeySchema.safeParse(parameter.key).success || !parameterTypesV2.has(parameter.type),
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
      !valueMatchesFieldV2(value as JsonValue, field)
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

  const operand = (entry: unknown): ResolvedTypedConditionOperandV2 => {
    const value = entry as { source: string; fieldId?: string; key?: string; value?: JsonValue };
    if (value.source === "field") {
      const fieldId = String(value.fieldId);
      const field = fieldsById.get(fieldId);
      if (!declaredFields.has(fieldId) || !field || !canonicalFieldValues.has(fieldId))
        refuse("field_refused");
      const declaredField = field ?? refuse("field_refused");
      return {
        type: semanticTypeForFieldV2(declaredField),
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

  return evaluateResolvedTypedConditionV2(parsedCondition.data!, operand);
}
