import {
  conditionValueType as typedSemanticFieldType,
  conditionFieldType as typedFieldValueType,
  conditionValueType,
  semanticTypeForLiteral,
  operatorAcceptsOperands,
  type OperandInfo,
} from "../../rules/condition-types";
import {
  parseExactDecimal,
  calculationMaximumNestingDepth,
  exactDecimalTextSchema,
  jsonValueSchema,
  type JsonValue,
} from "../../schema";
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
  if (object(settings.expression).kind !== "numeric" || settings.evaluation !== "stored")
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

export type NumericDimension = "dimensionless" | "money";

const numericDimension = (field: JsonObject | undefined): NumericDimension | undefined => {
  const type = typedFieldValueType(field);
  if (type === "whole_number" || type === "decimal_number") return "dimensionless";
  return type === "money" ? "money" : undefined;
};

export const exactIntegerLiteral = (value: unknown): boolean => {
  const parsed = parseExactDecimal(value);
  return parsed !== undefined && parsed.scale === 0;
};

export const calculationDependencyFieldIds = (expression: JsonObject): string[] => {
  const dependencies: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && !dependencies.includes(value)) dependencies.push(value);
  };
  const visitCondition = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (!Array.isArray(value) && object(value).source === "field") add(object(value).fieldId);
    for (const child of Array.isArray(value) ? value : Object.values(value)) visitCondition(child);
  };
  const visitNumberValue = (value: unknown, depth: number): boolean => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    if (depth > calculationMaximumNestingDepth) return false;
    const entry = object(value);
    if (entry.source === "numeric") {
      const operands = array(entry.operands);
      if (operands.length < 2) return false;
      return operands.every((operand) => visitNumberValue(operand, depth + 1));
    }
    if (entry.source === "field") add(entry.fieldId);
    return true;
  };
  if (expression.kind === "join_text")
    for (const fieldId of expression.fieldIds as string[]) add(fieldId);
  if (expression.kind === "numeric")
    for (const operand of array(expression.operands))
      if (!visitNumberValue(operand, 1)) {
        dependencies.length = 0;
        break;
      }
  if (expression.kind === "condition") visitCondition(expression.condition);
  if (expression.kind === "date_offset") {
    add(expression.dateFieldId);
    const amount = object(expression.amount);
    if (amount.source === "field") add(amount.fieldId);
  }
  if (expression.kind === "deadline_passed") {
    add(expression.dueFieldId);
    add(expression.statusFieldId);
  }
  return dependencies;
};

/**
 * The money dimension one operation yields from its operands' dimensions, or undefined when a
 * dimension is unknown or the operation's dimensions are not allowed. Money divided by money is
 * refused: only a dimensionless divisor keeps the dividend's currency.
 */
export const numericOperationDimension = (
  operation: string,
  dimensions: readonly (NumericDimension | undefined)[],
): NumericDimension | undefined => {
  if (dimensions.some((dimension) => dimension === undefined)) return undefined;
  const moneyPositions = dimensions.flatMap((dimension, index) =>
    dimension === "money" ? [index] : [],
  );
  const valid =
    operation === "add" || operation === "subtract"
      ? moneyPositions.length === 0 || moneyPositions.length === dimensions.length
      : operation === "multiply"
        ? moneyPositions.length <= 1
        : operation === "divide"
          ? moneyPositions.length === 0 || (moneyPositions.length === 1 && moneyPositions[0] === 0)
          : false;
  if (!valid) return undefined;
  return moneyPositions.length > 0 ? "money" : "dimensionless";
};

/** The money dimension of one numeric value, worked out through any nesting of operations. */
const numericValueDimension = (
  value: unknown,
  fields: ReadonlyMap<string, JsonObject>,
  depth = 1,
): NumericDimension | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (depth > calculationMaximumNestingDepth) return undefined;
  const entry = object(value);
  if (entry.source === "literal")
    return exactDecimalTextSchema.safeParse(entry.value).success
      ? ("dimensionless" as const)
      : undefined;
  if (entry.source === "field") return numericDimension(fields.get(String(entry.fieldId)));
  if (entry.source !== "numeric") return undefined;
  const operands = array(entry.operands);
  if (operands.length < 2) return undefined;
  return numericOperationDimension(
    String(entry.operation),
    operands.map((operand) => numericValueDimension(operand, fields, depth + 1)),
  );
};

export const numericExpressionValid = (
  expression: JsonObject,
  resultType: string,
  fields: ReadonlyMap<string, JsonObject>,
): boolean => {
  const dimension = numericOperationDimension(
    String(expression.operation),
    array(expression.operands).map((operand) => numericValueDimension(operand, fields)),
  );
  if (dimension === undefined) return false;
  return dimension === "money"
    ? resultType === "money"
    : resultType === "whole_number" || resultType === "decimal_number";
};

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
