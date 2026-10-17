import {
  parseExactDecimal,
  calculationMaximumNestingDepth,
  exactDecimalTextSchema,
  sourceExactDecimalTextSchema,
  sourceMoneyValueSchema,
  moneyValueSchema,
  platformIdSchema,
  jsonValueSchema,
  sourceModuleFieldValueSchemas,
  moduleFieldValueSchemas,
  valueTypesCompatible,
} from "../../schema";
import type { JsonObject } from "./context";
import { object, array } from "./helpers";

export function semanticFieldType(type: unknown): string | undefined {
  const value = String(type);
  if (["whole_number", "decimal_number", "money", "number"].includes(value)) return "number";
  if (value === "yes_no" || value === "boolean") return "boolean";
  if (value === "date" || value === "date_time") return value;
  if (["link", "link_to_one_of_several", "record_reference"].includes(value))
    return "record_reference";
  if (value === "organization_account_reference") return "organization_account_reference";
  if (value === "table" || value === "attachment" || value === "several_choices") return "json";
  if (
    [
      "text",
      "long_text",
      "formatted_text",
      "choice",
      "reference_number",
      "email_address",
      "phone_number",
      "web_address",
    ].includes(value)
  )
    return "text";
  return undefined;
}

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

function fieldValueType(field: JsonObject | undefined): string | undefined {
  if (!field) return undefined;
  const type = String(field.type);
  if (type === "calculation" || type === "total")
    return semanticFieldType(fieldDeclaredResultType(field));
  if (["whole_number", "decimal_number", "money"].includes(type)) return "number";
  if (type === "yes_no") return "boolean";
  if (type === "date" || type === "date_time") return type;
  if (["link", "link_to_one_of_several"].includes(type)) return "record_reference";
  if (type === "table" || type === "attachment" || type === "several_choices") return "json";
  return "text";
}

export type ModuleValueDialect = "source" | "canonical";

type ModuleValueDeclaration = Readonly<{
  field?: JsonObject;
  type?: string;
}>;

export function typedSemanticFieldType(type: unknown): string | undefined {
  const value = String(type);
  if (
    [
      "whole_number",
      "decimal_number",
      "money",
      "number",
      "boolean",
      "date",
      "date_time",
      "record_reference",
      "organization_account_reference",
    ].includes(value)
  )
    return value;
  if (value === "yes_no") return "boolean";
  if (["link", "link_to_one_of_several"].includes(value)) return "record_reference";
  if (value === "several_choices") return "text_collection";
  if (["table", "attachment", "formatted_text"].includes(value)) return "opaque_json";
  if (
    [
      "text",
      "long_text",
      "choice",
      "reference_number",
      "email_address",
      "phone_number",
      "web_address",
    ].includes(value)
  )
    return "text";
  return undefined;
}

export function typedFieldValueType(field: JsonObject | undefined): string | undefined {
  return field ? typedSemanticFieldType(fieldDeclaredResultType(field)) : undefined;
}

type NumericDimension = "dimensionless" | "money";

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
const numericOperationDimension = (
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

export function typedValueMatchesType(
  value: unknown,
  type: string,
  dialect: ModuleValueDialect = "canonical",
): boolean {
  if (type === "text") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "whole_number") return typeof value === "number" && Number.isInteger(value);
  if (type === "decimal_number")
    return (dialect === "source" ? sourceExactDecimalTextSchema : exactDecimalTextSchema).safeParse(
      value,
    ).success;
  if (type === "money")
    return (dialect === "source" ? sourceMoneyValueSchema : moneyValueSchema).safeParse(value)
      .success;
  if (type === "boolean") return typeof value === "boolean";
  if (type === "organization_account_reference") return platformIdSchema.safeParse(value).success;
  if (type === "date") return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (type === "date_time") return typeof value === "string" && !Number.isNaN(Date.parse(value));
  if (type === "record_reference")
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (dialect === "source"
        ? typeof object(value).record_type === "string" &&
          platformIdSchema.safeParse(object(value).record_id).success
        : platformIdSchema.safeParse(object(value).recordTypeId).success &&
          platformIdSchema.safeParse(object(value).recordId).success)
    );
  if (type === "text_collection")
    return Array.isArray(value) && value.every((entry) => typeof entry === "string");
  return type === "opaque_json" && jsonValueSchema.safeParse(value).success;
}

export function fieldValueMatches(
  value: unknown,
  field: JsonObject | undefined,
  dialect: ModuleValueDialect,
): boolean {
  if (!field) return false;
  if (field.type === "calculation" || field.type === "total") {
    const resultType = typedFieldValueType(field);
    return resultType !== undefined && typedValueMatchesType(value, resultType, dialect);
  }
  const schemas = dialect === "source" ? sourceModuleFieldValueSchemas : moduleFieldValueSchemas;
  const schema = schemas[String(field.type) as keyof typeof schemas];
  if (schema === undefined || !schema.safeParse(value).success) return false;
  const expectedRecordTypeIds = fieldRecordTypeIds(field);
  if (expectedRecordTypeIds === undefined) return true;
  const actualRecordTypeId = object(value)[dialect === "source" ? "record_type" : "recordTypeId"];
  return (
    typeof actualRecordTypeId === "string" && expectedRecordTypeIds.includes(actualRecordTypeId)
  );
}

const conditionCollectionElementType = (type: string | undefined): type is string =>
  type !== undefined && type !== "text_collection" && type !== "opaque_json";

function typedNaturalLiteralType(value: unknown): string | undefined {
  if (value === null) return undefined;
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
    if (!Number.isNaN(Date.parse(value))) return "date_time";
    return "text";
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
    return "text_collection";
  return "opaque_json";
}

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
        : { source: "value", value: condition.value }
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
  const matches = (literalValue: unknown, expected: ModuleValueDeclaration | undefined) =>
    literalValue === null ||
    (expected?.field
      ? fieldValueMatches(literalValue, expected.field, dialect)
      : expected?.type !== undefined &&
        typedValueMatchesType(literalValue, expected.type, dialect));
  const leftDeclaration = declaration(authoredLeft);
  if (!leftDeclaration) return false;
  const operator = String(condition.operator);
  if (operator === "is_empty" || operator === "is_not_empty")
    return dialect === "source"
      ? condition.left === undefined &&
          condition.parameter === undefined &&
          condition.value === undefined
      : authoredRight === undefined;
  const rightDeclaration = declaration(authoredRight);
  if (!rightDeclaration) return false;
  const leftLiteral = literal(authoredLeft);
  const rightLiteral = literal(authoredRight);
  const leftIsLiteral = object(authoredLeft).source === "value";
  const rightIsLiteral = object(authoredRight).source === "value";

  if (["in", "not_in"].includes(operator)) {
    const elementType = leftDeclaration.type ?? typedNaturalLiteralType(leftLiteral);
    if (!conditionCollectionElementType(elementType)) return false;
    if (!rightIsLiteral)
      return rightDeclaration.type === "text_collection" && elementType === "text";
    if (!Array.isArray(rightLiteral)) return false;
    return rightLiteral.every((entry) =>
      leftDeclaration.type
        ? matches(entry, leftDeclaration)
        : typedValueMatchesType(entry, elementType, dialect),
    );
  }
  if (["contains", "not_contains"].includes(operator)) {
    if (Array.isArray(leftLiteral))
      return leftLiteral.every((entry) => matches(entry, rightDeclaration));
    if (rightLiteral !== undefined) {
      if (leftDeclaration.type === "text_collection") return typeof rightLiteral === "string";
      if (leftDeclaration.type === "text") return typeof rightLiteral === "string";
    }
  }
  if (leftIsLiteral && !matches(leftLiteral, rightDeclaration)) return false;
  if (rightIsLiteral && !matches(rightLiteral, leftDeclaration)) return false;
  const leftType = leftDeclaration.type ?? rightDeclaration.type;
  const rightType = rightDeclaration.type ?? leftDeclaration.type;
  if (!leftType || !rightType) return false;
  if (["contains", "not_contains"].includes(operator))
    return (leftType === "text" && rightType === "text") || leftType === "text_collection";
  if (
    ["greater_than", "greater_than_or_equal", "less_than", "less_than_or_equal"].includes(operator)
  )
    return (
      valueTypesCompatible(leftType, rightType, "condition") &&
      ["number", "whole_number", "decimal_number", "money", "date", "date_time", "text"].includes(
        leftType,
      )
    );
  return valueTypesCompatible(leftType, rightType, "condition");
}

export function fieldRecordTypeIds(field: JsonObject | undefined): string[] | undefined {
  if (!field) return undefined;
  const settings = object(field.settings);
  if (field.type === "link")
    return [
      typeof settings.target === "string"
        ? settings.target
        : String(object(settings.target).recordTypeId),
    ];
  if (field.type === "link_to_one_of_several")
    return array(settings.targets).map((target) =>
      typeof target === "string" ? target : String(target.recordTypeId),
    );
  return undefined;
}

function literalValueType(value: unknown): string | undefined {
  if (value === null || Array.isArray(value) || typeof value === "object") return "json";
  if (typeof value === "number" && Number.isFinite(value)) return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value !== "string") return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
  if (!Number.isNaN(Date.parse(value))) return "date_time";
  return "text";
}

export function conditionTypesValid(
  value: unknown,
  fields: ReadonlyMap<string, JsonObject>,
  parameters: ReadonlyMap<string, string> = new Map(),
): boolean {
  if (value === null || value === undefined) return true;
  const condition = object(value);
  if (condition.kind === "all" || condition.kind === "any")
    return array(condition.conditions).every((entry) =>
      conditionTypesValid(entry, fields, parameters),
    );
  if (condition.kind === "not") return conditionTypesValid(condition.condition, fields, parameters);
  if (condition.kind !== "comparison") return false;
  const operandType = (operandValue: unknown) => {
    const operand = object(operandValue);
    if (operand.source === "field") return fieldValueType(fields.get(String(operand.fieldId)));
    if (operand.source === "parameter") return parameters.get(String(operand.key));
    return operand.source === "value" ? literalValueType(operand.value) : undefined;
  };
  const leftType = operandType(condition.left);
  if (!leftType) return false;
  if (condition.operator === "is_empty" || condition.operator === "is_not_empty")
    return condition.right === undefined;
  const rightType = operandType(condition.right);
  if (!rightType) return false;
  if (["contains", "not_contains"].includes(String(condition.operator)))
    return (
      (leftType === "text" && (rightType === "text" || rightType === "json")) ||
      (leftType === "json" && (rightType === "text" || rightType === "json"))
    );
  if (["in", "not_in"].includes(String(condition.operator))) return rightType === "json";
  if (
    ["greater_than", "greater_than_or_equal", "less_than", "less_than_or_equal"].includes(
      String(condition.operator),
    )
  )
    return leftType === rightType && ["number", "date", "date_time", "text"].includes(leftType);
  return leftType === rightType || (leftType === "date_time" && rightType === "date");
}
