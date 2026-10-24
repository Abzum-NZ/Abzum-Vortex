import { calculationFormulaDependencies } from "../module-calculation-formula";
import { flowFormulaSchema } from "../../workflows/flow-values";
import {
  conditionValueType as typedSemanticFieldType,
  conditionFieldType as typedFieldValueType,
  conditionValueType,
  semanticTypeForLiteral,
  operatorAcceptsOperands,
  type OperandInfo,
} from "../../rules/condition-types";
import { jsonValueSchema, type JsonValue } from "../../schema";
import type { JsonObject } from "./context";
import { object, array } from "./helpers";

export function fieldDeclaredResultType(field: JsonObject | undefined): string | undefined {
  if (!field) return undefined;
  if (field.type === "calculation" || field.type === "total") {
    const settings = object(field.settings);
    const resultType = settings.resultType ?? settings.result_type;
    return typeof resultType === "string" ? resultType : undefined;
  }
  return String(field.type);
}

export function storedNumericSummaryResultType(field: JsonObject | undefined): string | undefined {
  if (!field || field.type !== "calculation") return undefined;
  const settings = object(field.settings);
  if (
    !["add", "subtract", "multiply", "divide", "round"].includes(
      String(object(settings.expression).op),
    ) ||
    settings.evaluation !== "stored"
  )
    return undefined;
  const resultType = fieldDeclaredResultType(field);
  return resultType === "whole_number" || resultType === "decimal_number" ? resultType : undefined;
}

export type ModuleValueDialect = "source" | "canonical";

type ModuleValueDeclaration = Readonly<{
  field?: JsonObject;
  type?: string;
}>;

export {
  typedValueMatchesType,
  conditionValueType as typedSemanticFieldType,
  conditionFieldType as typedFieldValueType,
  fieldValueMatches,
  fieldRecordTypeIds,
} from "../../rules/condition-types";

export const calculationDependencyFieldIds = (expression: JsonObject): string[] =>
  calculationFormulaDependencies(flowFormulaSchema.parse(expression));

export function typedConditionTypesValid(
  value: unknown,
  fields: ReadonlyMap<string, JsonObject>,
  parameters: ReadonlyMap<string, string> = new Map(),
  dialect: ModuleValueDialect = "canonical",
): boolean {
  if (value === null || value === undefined) return true;
  const condition = object(value);
  const all =
    dialect === "source"
      ? condition.all
      : condition.kind === "all"
        ? condition.conditions
        : undefined;
  const any =
    dialect === "source"
      ? condition.any
      : condition.kind === "any"
        ? condition.conditions
        : undefined;
  const not =
    dialect === "source"
      ? condition.not
      : condition.kind === "not"
        ? condition.condition
        : undefined;
  if (all)
    return array(all).every((entry) =>
      typedConditionTypesValid(entry, fields, parameters, dialect),
    );
  if (any)
    return array(any).every((entry) =>
      typedConditionTypesValid(entry, fields, parameters, dialect),
    );
  if (not) return typedConditionTypesValid(not, fields, parameters, dialect);
  if (dialect === "canonical" && condition.kind !== "comparison") return false;

  const authoredLeft =
    dialect === "source" && condition.left === undefined
      ? { source: "field", field: condition.field }
      : condition.left;
  const authoredRight =
    dialect === "source" && condition.right === undefined
      ? condition.parameter !== undefined
        ? { source: "parameter", parameter: condition.parameter }
        : condition.value !== undefined
          ? { source: "value", value: condition.value }
          : undefined
      : condition.right;
  const declaration = (operandValue: unknown): ModuleValueDeclaration | undefined => {
    const operand = object(operandValue);
    if (operand.source === "field") {
      const field = fields.get(String(operand[dialect === "source" ? "field" : "fieldId"]));
      if (!field) return undefined;
      const type = typedFieldValueType(field);
      return { field, ...(type === undefined ? {} : { type }) };
    }
    if (operand.source === "parameter") {
      const type = parameters.get(String(operand[dialect === "source" ? "parameter" : "key"]));
      if (!type) return undefined;
      const semanticType = typedSemanticFieldType(type);
      return semanticType === undefined ? undefined : { type: semanticType };
    }
    return operand.source === "value" ? {} : undefined;
  };
  const literal = (operandValue: unknown): unknown => {
    const operand = object(operandValue);
    return operand.source === "value" ? operand.value : undefined;
  };
  const info = (operand: unknown): OperandInfo | undefined => {
    const declared = declaration(operand);
    if (!declared) return undefined;
    if (object(operand).source !== "value")
      return {
        source: "reference",
        semanticType: conditionValueType(declared.type),
        ...(declared.field ? { field: declared.field } : {}),
        dialect,
      };
    const candidate = literal(operand);
    if (!jsonValueSchema.safeParse(candidate).success) return undefined;
    return {
      source: "value",
      literal: candidate as JsonValue,
      semanticType: semanticTypeForLiteral(candidate as JsonValue),
    };
  };
  const left = info(authoredLeft);
  if (!left) return false;
  const right = authoredRight === undefined ? undefined : info(authoredRight);
  if (authoredRight !== undefined && !right) return false;
  return operatorAcceptsOperands(String(condition.operator), left, right);
}
