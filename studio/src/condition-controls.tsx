"use client";

import { useState } from "react";
import {
  builderKeySchema,
  conditionMaximumNestingDepth,
  conditionMaximumOperandCount,
  conditionNodeSchema,
  dateValueV2Schema,
  exactDecimalTextV2Schema,
  fieldIdSchema,
  jsonValueSchema,
  moduleFieldV3Schema,
  moneyValueV2Schema,
  organizationAccountIdSchema,
  personLinkValueV2Schema,
  recordLinkValueV2Schema,
  type ConditionNode,
  type JsonValue,
  type ModuleFieldV3,
} from "@vortex/contracts";

type ComparisonCondition = Extract<ConditionNode, { kind: "comparison" }>;
type ConditionOperand = ComparisonCondition["left"];
type FieldOperand = Extract<ConditionOperand, { source: "field" }>;
type ParameterOperand = Extract<ConditionOperand, { source: "parameter" }>;

/** The semantic types used by the current Rule V2 field and parameter contracts. */
export type StudioConditionSemanticType =
  | "text"
  | "number"
  | "whole_number"
  | "decimal_number"
  | "money"
  | "boolean"
  | "date"
  | "date_time"
  | "text_collection"
  | "opaque_json"
  | "record_reference"
  | "organization_account_reference";

/** Parameter types accepted by Rule V2. Host-only values use the same parameter source. */
export type StudioConditionParameterType =
  | "text"
  | "number"
  | "decimal_number"
  | "money"
  | "boolean"
  | "date"
  | "date_time"
  | "organization_account_reference";

export type StudioConditionOperandRole =
  | "current_field"
  | "previous_field"
  | "declared_input"
  | "event_value"
  | "variable"
  | "trusted_account_context"
  | "host_context";

/**
 * The host grants each available reference explicitly. Previous values, inputs, variables and
 * trusted context use the existing `parameter` operand and must have a matching Rule V2
 * declaration; current Module fields use the existing `field` operand and their Module metadata.
 */
export type StudioConditionOperandPermission =
  | Readonly<{
      operand: FieldOperand;
      field: ModuleFieldV3;
      label: string;
      role: "current_field";
    }>
  | Readonly<{
      operand: ParameterOperand;
      label: string;
      role: Exclude<StudioConditionOperandRole, "current_field">;
    }>;

export type StudioConditionParameterDeclaration = Readonly<{
  key: string;
  type: StudioConditionParameterType;
}>;

export type StudioConditionControlsContext = Readonly<{
  /** Only operands listed here can be selected or retained in the authored tree. */
  allowedOperands: readonly StudioConditionOperandPermission[];
  /** The source fields the owning host declared for this Rule V2 evaluation context. */
  declaredFieldIds: readonly string[];
  /** Exact Rule V2 declarations resolve the types of every permitted parameter operand. */
  parameterDeclarations: readonly StudioConditionParameterDeclaration[];
  /** Literal values are opt-in so each host can apply its own authoring policy. */
  allowLiteralValues: boolean;
  /** An omitted operator list permits the current Rule V2 operator catalogue. */
  allowedOperators?: readonly StudioConditionOperator[];
}>;

export type StudioConditionOperator = ComparisonCondition["operator"];
export type StudioConditionOperatorOption = Readonly<{
  operator: StudioConditionOperator;
  label: string;
  arity: "unary" | "binary";
}>;

type ConditionOperator = StudioConditionOperator;

const unaryOperators = new Set<ConditionOperator>(["is_empty", "is_not_empty"]);
const operatorLabels = {
  equals: "equals",
  not_equals: "does not equal",
  contains: "contains",
  not_contains: "does not contain",
  in: "is in",
  not_in: "is not in",
  greater_than: "is greater than",
  greater_than_or_equal: "is at least",
  less_than: "is less than",
  less_than_or_equal: "is at most",
  is_empty: "is empty",
  is_not_empty: "is not empty",
} as const satisfies Record<ConditionOperator, string>;
const operatorOptions: readonly StudioConditionOperatorOption[] = (
  Object.keys(operatorLabels) as ConditionOperator[]
).map((operator) => ({
  operator,
  label: operatorLabels[operator],
  arity: unaryOperators.has(operator) ? "unary" : "binary",
}));
const orderableTypes = new Set<StudioConditionSemanticType>([
  "text",
  "number",
  "whole_number",
  "decimal_number",
  "money",
  "date",
  "date_time",
]);
const numericTypes = new Set<StudioConditionSemanticType>([
  "number",
  "whole_number",
  "decimal_number",
]);
const exactNumericTypes = new Set<StudioConditionSemanticType>([
  "whole_number",
  "decimal_number",
]);
const maximumGroupChildren = 50;

export type StudioConditionValidationIssue = Readonly<{
  code:
    | "invalid_condition"
    | "invalid_context"
    | "operand_not_permitted"
    | "literal_not_permitted"
    | "operator_incompatible"
    | "invalid_literal";
  /** JSON pointer into the shared condition tree; the empty string locates the root. */
  pointer: string;
  path: readonly (string | number)[];
  message: string;
}>;

/** Validation returns only the current shared condition tree and located issues. */
export type StudioConditionValidation = Readonly<{
  condition: ConditionNode | undefined;
  issues: readonly StudioConditionValidationIssue[];
  isValid: boolean;
}>;

type OperandInfo = Readonly<{
  semanticType: StudioConditionSemanticType | undefined;
  literal?: JsonValue;
  source: "reference" | "value";
}>;

type ConditionPath = readonly (string | number)[];

const roleLabels: Readonly<Record<StudioConditionOperandRole, string>> = {
  current_field: "Current fields",
  previous_field: "Previous values",
  declared_input: "Declared inputs",
  event_value: "Event values",
  variable: "Variables",
  trusted_account_context: "Trusted account context",
  host_context: "Host context",
};

const pointerForPath = (path: ConditionPath): string =>
  path.length === 0
    ? ""
    : `/${path.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;

const makeIssue = (
  code: StudioConditionValidationIssue["code"],
  path: ConditionPath,
  message: string,
): StudioConditionValidationIssue => ({
  code,
  pointer: pointerForPath(path),
  path,
  message,
});

const conditionOperandCount = (condition: ConditionNode): number => {
  if (condition.kind === "comparison") return condition.right === undefined ? 1 : 2;
  if (condition.kind === "not") return conditionOperandCount(condition.condition);
  return condition.conditions.reduce((count, child) => count + conditionOperandCount(child), 0);
};

const conditionDepth = (condition: ConditionNode): number => {
  if (condition.kind === "comparison") return 1;
  if (condition.kind === "not") return 1 + conditionDepth(condition.condition);
  return 1 + Math.max(...condition.conditions.map(conditionDepth));
};

const conditionLevelForPath = (path: ConditionPath): number =>
  1 + path.filter((part) => part === "conditions" || part === "condition").length;

const referenceKey = (operand: Exclude<ConditionOperand, { source: "value" }>): string =>
  operand.source === "field" ? `field:${operand.fieldId}` : `parameter:${operand.key}`;

const permissionKey = (permission: StudioConditionOperandPermission): string =>
  referenceKey(permission.operand);

const fieldMetadataForPermission = (
  permission: StudioConditionOperandPermission,
): ModuleFieldV3 | undefined =>
  "field" in permission ? permission.field : undefined;

const semanticTypeForField = (field: ModuleFieldV3): StudioConditionSemanticType => {
  switch (field.type) {
    case "whole_number":
      return "whole_number";
    case "decimal_number":
      return "decimal_number";
    case "money":
      return "money";
    case "yes_no":
      return "boolean";
    case "date":
      return "date";
    case "date_time":
      return "date_time";
    case "several_choices":
      return "text_collection";
    case "formatted_text":
    case "table":
    case "attachment":
      return "opaque_json";
    case "link":
    case "link_to_one_of_several":
      return "record_reference";
    case "link_to_person":
      return "organization_account_reference";
    case "calculation":
    case "total": {
      const resultType = field.settings.resultType;
      if (resultType === "whole_number") return "whole_number";
      if (resultType === "decimal_number") return "decimal_number";
      if (resultType === "money") return "money";
      if (resultType === "yes_no") return "boolean";
      if (resultType === "date") return "date";
      if (resultType === "date_time") return "date_time";
      return "text";
    }
    default:
      return "text";
  }
};

const semanticTypeForParameter = (
  type: StudioConditionParameterType,
): StudioConditionSemanticType => type;

const contextIssues = (
  context: StudioConditionControlsContext,
): StudioConditionValidationIssue[] => {
  const issues: StudioConditionValidationIssue[] = [];
  if (
    !context ||
    !Array.isArray(context.allowedOperands) ||
    !Array.isArray(context.declaredFieldIds) ||
    !Array.isArray(context.parameterDeclarations) ||
    typeof context.allowLiteralValues !== "boolean"
  )
    return [makeIssue("invalid_context", [], "The condition host context is invalid")];

  if (context.allowedOperators !== undefined) {
    if (!Array.isArray(context.allowedOperators))
      issues.push(makeIssue("invalid_context", ["allowedOperators"], "Allowed operators must be a list"));
    else {
      const seenOperators = new Set<string>();
      for (const [index, operator] of context.allowedOperators.entries()) {
        if (typeof operator !== "string" || !Object.prototype.hasOwnProperty.call(operatorLabels, operator))
          issues.push(makeIssue("invalid_context", ["allowedOperators", index], "An allowed operator is invalid"));
        if (seenOperators.has(operator))
          issues.push(makeIssue("invalid_context", ["allowedOperators", index], "An operator is listed more than once"));
        seenOperators.add(operator);
      }
    }
  }

  const validTypes = new Set<StudioConditionParameterType>([
    "text",
    "number",
    "decimal_number",
    "money",
    "boolean",
    "date",
    "date_time",
    "organization_account_reference",
  ]);
  const parameterDeclarations = new Map<string, StudioConditionParameterType>();
  for (const [index, declaration] of context.parameterDeclarations.entries()) {
    if (
      !declaration ||
      typeof declaration !== "object" ||
      !builderKeySchema.safeParse(declaration.key).success ||
      !validTypes.has(declaration.type)
    ) {
      issues.push(makeIssue("invalid_context", ["parameterDeclarations", index], "A parameter declaration is invalid"));
      continue;
    }
    if (parameterDeclarations.has(declaration.key))
      issues.push(makeIssue("invalid_context", ["parameterDeclarations", index], "A parameter key is declared more than once"));
    parameterDeclarations.set(declaration.key, declaration.type);
  }

  const declaredFieldIds = new Set<string>();
  for (const [index, fieldId] of context.declaredFieldIds.entries()) {
    const parsedFieldId = fieldIdSchema.safeParse(fieldId);
    if (!parsedFieldId.success) {
      issues.push(makeIssue("invalid_context", ["declaredFieldIds", index], "A declared field identity is invalid"));
      continue;
    }
    if (declaredFieldIds.has(parsedFieldId.data))
      issues.push(makeIssue("invalid_context", ["declaredFieldIds", index], "A field identity is declared more than once"));
    declaredFieldIds.add(parsedFieldId.data);
  }

  const seen = new Set<string>();
  for (const [index, permission] of context.allowedOperands.entries()) {
    if (
      !permission ||
      typeof permission !== "object" ||
      typeof permission.label !== "string" ||
      permission.label.trim().length === 0 ||
      !permission.operand ||
      typeof permission.operand !== "object" ||
      (permission.operand.source !== "field" && permission.operand.source !== "parameter") ||
      typeof permission.role !== "string" ||
      !Object.prototype.hasOwnProperty.call(roleLabels, permission.role)
    ) {
      issues.push(makeIssue("invalid_context", ["allowedOperands", index], "An allowed operand is invalid"));
      continue;
    }
    const key = permissionKey(permission);
    if (seen.has(key))
      issues.push(makeIssue("invalid_context", ["allowedOperands", index], "An operand is listed more than once"));
    seen.add(key);

    if (permission.operand.source === "field") {
      const parsedField = moduleFieldV3Schema.safeParse(fieldMetadataForPermission(permission));
      if (
        !parsedField.success ||
        parsedField.data.fieldId !== permission.operand.fieldId ||
        !declaredFieldIds.has(permission.operand.fieldId) ||
        permission.role !== "current_field"
      )
        issues.push(makeIssue("invalid_context", ["allowedOperands", index], "A current field must match its Module metadata"));
    } else {
      const parsedKey = builderKeySchema.safeParse(permission.operand.key);
      const declaredType = parameterDeclarations.get(permission.operand.key);
      if (!parsedKey.success || declaredType === undefined || String(permission.role) === "current_field")
        issues.push(makeIssue("invalid_context", ["allowedOperands", index], "A parameter must match a Rule V2 declaration"));
      if (
        permission.role === "trusted_account_context" &&
        declaredType !== "organization_account_reference"
      )
        issues.push(makeIssue("invalid_context", ["allowedOperands", index], "Trusted account context must use its declared account type"));
    }
  }
  return issues;
};

const infoForOperand = (
  operand: ConditionOperand,
  context: StudioConditionControlsContext,
): OperandInfo | undefined => {
  if (operand.source === "value")
    return { source: "value", literal: operand.value, semanticType: semanticTypeForLiteral(operand.value) };
  const permission = context.allowedOperands.find(
    (candidate) => permissionKey(candidate) === referenceKey(operand),
  );
  if (!permission) return undefined;
  if (permission.operand.source === "parameter") {
    const declaredType = context.parameterDeclarations.find(
      (declaration) => declaration.key === permission.operand.key,
    )?.type;
    return declaredType
      ? { source: "reference", semanticType: semanticTypeForParameter(declaredType) }
      : undefined;
  }
  const field = fieldMetadataForPermission(permission);
  if (!field) return undefined;
  return {
    source: "reference",
    semanticType: semanticTypeForField(field),
  };
};

const isValidText = (value: unknown): value is string =>
  typeof value === "string" &&
  !value.includes("\0") &&
  [...value].every((character) => {
    const point = character.codePointAt(0)!;
    return point < 0xd800 || point > 0xdfff;
  });

const isValidInstant = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) return false;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (!dateValueV2Schema.safeParse(value.slice(0, 10)).success) return false;
  const zone = match[8]!;
  if (zone === "Z") return true;
  const offsetHours = Number(zone.slice(1, 3));
  const offsetMinutes = Number(zone.slice(4, 6));
  return offsetHours <= 23 && offsetMinutes <= 59;
};

const semanticTypeForLiteral = (value: JsonValue): StudioConditionSemanticType | undefined => {
  if (value === null) return undefined;
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") {
    if (dateValueV2Schema.safeParse(value).success) return "date";
    if (isValidInstant(value)) return "date_time";
    return "text";
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
    return "text_collection";
  return "opaque_json";
};

const literalMatchesType = (value: JsonValue, type: StudioConditionSemanticType): boolean => {
  if (value === null) return true;
  switch (type) {
    case "text":
      return isValidText(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "whole_number":
      return typeof value === "number" && Number.isInteger(value);
    case "decimal_number":
      return (
        exactDecimalTextV2Schema.safeParse(value).success ||
        (typeof value === "number" && Number.isInteger(value))
      );
    case "money":
      return moneyValueV2Schema.safeParse(value).success;
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return dateValueV2Schema.safeParse(value).success;
    case "date_time":
      return isValidInstant(value);
    case "text_collection":
      return Array.isArray(value) && value.every(isValidText);
    case "opaque_json":
      return jsonValueSchema.safeParse(value).success;
    case "record_reference":
      return recordLinkValueV2Schema.safeParse(value).success;
    case "organization_account_reference":
      return (
        organizationAccountIdSchema.safeParse(value).success ||
        personLinkValueV2Schema.safeParse(value).success
      );
  }
};

const sameComparableType = (
  left: StudioConditionSemanticType,
  right: StudioConditionSemanticType,
): boolean =>
  left === right || (exactNumericTypes.has(left) && exactNumericTypes.has(right));

const exactNumericLiteral = (value: JsonValue | undefined): boolean =>
  value === null ||
  (typeof value === "number" && Number.isInteger(value)) ||
  (typeof value === "string" && exactDecimalTextV2Schema.safeParse(value).success);

const exactNumericOperand = (operand: OperandInfo): boolean =>
  operand.source === "value"
    ? exactNumericLiteral(operand.literal)
    : operand.semanticType !== undefined && exactNumericTypes.has(operand.semanticType);

const sharedType = (
  left: OperandInfo,
  right: OperandInfo,
): StudioConditionSemanticType | undefined => {
  if (left.source === "value" && right.source === "value") {
    if (left.literal === null && right.literal === null) return "opaque_json";
    if (left.literal === null && right.literal !== undefined)
      return semanticTypeForLiteral(right.literal);
    if (right.literal === null && left.literal !== undefined)
      return semanticTypeForLiteral(left.literal);
    return left.semanticType === right.semanticType ? left.semanticType : undefined;
  }

  if (left.source === "reference" && right.source === "reference") {
    if (left.semanticType === right.semanticType) return left.semanticType;
    return left.semanticType && right.semanticType &&
      sameComparableType(left.semanticType, right.semanticType) &&
      exactNumericOperand(left) && exactNumericOperand(right)
      ? "decimal_number"
      : undefined;
  }

  const reference = left.source === "reference" ? left : right;
  const literal = left.source === "value" ? left : right;
  const referenceType = reference.semanticType;
  if (!referenceType || literal.literal === undefined) return undefined;
  if (literalMatchesType(literal.literal, referenceType)) return referenceType;
  return numericTypes.has(referenceType) && exactNumericOperand(reference) &&
    exactNumericOperand(literal)
    ? "decimal_number"
    : undefined;
};

const canBeType = (operand: OperandInfo, type: StudioConditionSemanticType): boolean =>
  operand.source === "reference"
    ? operand.semanticType === type
    : operand.literal !== undefined && literalMatchesType(operand.literal, type);

const isCollectionElementType = (
  type: StudioConditionSemanticType | undefined,
): type is Exclude<StudioConditionSemanticType, "text_collection" | "opaque_json"> =>
  type !== undefined && type !== "text_collection" && type !== "opaque_json";

const collectionElementType = (
  operand: OperandInfo,
  expectedType?: StudioConditionSemanticType,
): Exclude<StudioConditionSemanticType, "text_collection" | "opaque_json"> | undefined => {
  if (operand.source === "reference")
    return operand.semanticType === "text_collection" ? "text" : undefined;
  if (!Array.isArray(operand.literal)) return undefined;
  if (operand.literal.length === 0)
    return isCollectionElementType(expectedType) ? expectedType : undefined;
  if (expectedType && operand.literal.every((value) => literalMatchesType(value, expectedType)))
    return isCollectionElementType(expectedType) ? expectedType : undefined;
  const types = operand.literal.map(semanticTypeForLiteral);
  const firstType = types[0];
  return types.every((type) => type === firstType) && isCollectionElementType(firstType)
    ? firstType
    : undefined;
};

const knownReferenceType = (operand: OperandInfo): StudioConditionSemanticType | undefined =>
  operand.source === "reference" ? operand.semanticType : undefined;

const operatorAcceptsOperands = (
  operator: ConditionOperator,
  left: OperandInfo,
  right: OperandInfo | undefined,
): boolean => {
  if (unaryOperators.has(operator)) return right === undefined;
  if (!right) return false;

  if (operator === "equals" || operator === "not_equals") return sharedType(left, right) !== undefined;
  if (operator === "contains" || operator === "not_contains") {
    const textOperands = canBeType(left, "text") && canBeType(right, "text");
    const elementType = collectionElementType(left, knownReferenceType(right));
    return textOperands || (elementType !== undefined && canBeType(right, elementType));
  }
  if (operator === "in" || operator === "not_in") {
    const elementType = collectionElementType(right, knownReferenceType(left));
    return elementType !== undefined && canBeType(left, elementType);
  }
  const type = sharedType(left, right);
  if (type === "money" && left.source === "value" && right.source === "value" &&
    left.literal !== null && right.literal !== null) {
    const leftMoney = moneyValueV2Schema.safeParse(left.literal);
    const rightMoney = moneyValueV2Schema.safeParse(right.literal);
    if (leftMoney.success && rightMoney.success &&
      leftMoney.data.currency !== rightMoney.data.currency) return false;
  }
  return type !== undefined && orderableTypes.has(type);
};

const defaultLiteralForType = (type: StudioConditionSemanticType | undefined): JsonValue | undefined => {
  switch (type) {
    case "number":
    case "whole_number":
      return 0;
    case "decimal_number":
      return "0";
    case "money":
      return null;
    case "boolean":
      return false;
    case "date":
      return "1970-01-01";
    case "date_time":
      return "1970-01-01T00:00:00Z";
    case "text_collection":
      return [];
    case "record_reference":
    case "organization_account_reference":
    case "opaque_json":
      return null;
    case "text":
    case undefined:
      return "";
  }
};

const literalOperand = (type: StudioConditionSemanticType | undefined): ConditionOperand => ({
  source: "value",
  value: defaultLiteralForType(type) ?? null,
});

const candidateRightOperands = (
  left: ConditionOperand,
  context: StudioConditionControlsContext,
): ConditionOperand[] => {
  const candidates: ConditionOperand[] = context.allowedOperands.map((entry) => entry.operand);
  if (context.allowLiteralValues) {
    const leftInfo = infoForOperand(left, context);
    const type = leftInfo?.semanticType;
    candidates.push(literalOperand(type));
    if (type === "text") candidates.push({ source: "value", value: [] });
    if (type === "text_collection") candidates.push({ source: "value", value: "" });
    candidates.push({ source: "value", value: [] });
    if (
      left.source === "value" &&
      left.value !== null &&
      !Array.isArray(left.value)
    )
      candidates.push({ source: "value", value: [left.value] });
    const elementType = leftInfo && collectionElementType(leftInfo);
    if (elementType) candidates.push(literalOperand(elementType));
  }
  return candidates;
};

/**
 * Filters editor options from the shared operator vocabulary and Rule V2 semantic types.
 * This authoring guard never evaluates a condition; Rule remains the only evaluator.
 */
export function studioConditionOperatorsFor(
  left: ConditionOperand,
  right: ConditionOperand | undefined,
  context: StudioConditionControlsContext,
): readonly StudioConditionOperatorOption[] {
  if (contextIssues(context).length > 0) return [];
  const leftInfo = infoForOperand(left, context);
  if (!leftInfo) return [];
  return operatorOptions.filter((option) => {
    if (context.allowedOperators !== undefined && !context.allowedOperators.includes(option.operator)) return false;
    if (option.arity === "unary") return true;
    const rightCandidates = right === undefined
      ? candidateRightOperands(left, context)
      : [right, ...candidateRightOperands(left, context)];
    return rightCandidates.some((candidate) => {
      const rightInfo = infoForOperand(candidate, context);
      return rightInfo !== undefined && operatorAcceptsOperands(option.operator, leftInfo, rightInfo);
    });
  });
}

const defaultRightForOperator = (
  operator: ConditionOperator,
  left: ConditionOperand,
  context: StudioConditionControlsContext,
): ConditionOperand | undefined => {
  const leftInfo = infoForOperand(left, context);
  if (!leftInfo) return undefined;
  const candidates = candidateRightOperands(left, context);
  return candidates.find((candidate) => {
    const info = infoForOperand(candidate, context);
    return info !== undefined && operatorAcceptsOperands(operator, leftInfo, info);
  });
};

/** Creates a valid unary leaf from the host's first permitted operand. */
export function createInitialStudioCondition(
  context: StudioConditionControlsContext,
): ConditionNode | undefined {
  if (
    !context ||
    !Array.isArray(context.allowedOperands) ||
    !Array.isArray(context.declaredFieldIds) ||
    !Array.isArray(context.parameterDeclarations) ||
    typeof context.allowLiteralValues !== "boolean"
  )
    return undefined;
  if (contextIssues(context).length > 0) return undefined;
  const operands: ConditionOperand[] = context.allowedOperands.map((entry) => entry.operand);
  if (context.allowLiteralValues) operands.push(literalOperand("text"));
  for (const operand of operands) {
    const options = studioConditionOperatorsFor(operand, undefined, context);
    const option = options.find((entry) => entry.arity === "unary") ?? options[0];
    if (!option) continue;
    if (option.arity === "unary")
      return { kind: "comparison", operator: option.operator, left: operand };
    const right = defaultRightForOperator(option.operator, operand, context);
    if (right) return { kind: "comparison", operator: option.operator, left: operand, right };
  }
  return undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const addContractLimitIssues = (
  value: unknown,
  path: ConditionPath,
  depth: number,
  operandCount: { value: number },
  issues: StudioConditionValidationIssue[],
): void => {
  if (!isRecord(value) || typeof value.kind !== "string") return;
  if (depth > conditionMaximumNestingDepth) {
    issues.push(makeIssue("invalid_condition", path, `Condition nesting cannot exceed ${conditionMaximumNestingDepth} levels`));
    return;
  }
  if (value.kind === "comparison") {
    for (const key of ["left", "right"] as const) {
      if (key === "right" && value.right === undefined) continue;
      operandCount.value += 1;
      if (operandCount.value > conditionMaximumOperandCount)
        issues.push(makeIssue("invalid_condition", [...path, key], `Condition operands cannot exceed ${conditionMaximumOperandCount}`));
    }
    return;
  }
  if (value.kind === "not") {
    addContractLimitIssues(value.condition, [...path, "condition"], depth + 1, operandCount, issues);
    return;
  }
  if ((value.kind === "all" || value.kind === "any") && Array.isArray(value.conditions))
    value.conditions.forEach((child, index) =>
      addContractLimitIssues(child, [...path, "conditions", index], depth + 1, operandCount, issues),
    );
};

/** Validates the canonical tree, host allowlist, and type-valid operator choices with JSON pointers. */
export function validateStudioCondition(
  value: unknown,
  context: StudioConditionControlsContext,
): StudioConditionValidation {
  const issues = contextIssues(context);
  if (value === undefined)
    return { condition: undefined, issues, isValid: issues.length === 0 };
  const parsed = conditionNodeSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.filter(
        (part): part is string | number => typeof part === "string" || typeof part === "number",
      );
      if (
        path.length === 0 &&
        (issue.message.includes("nesting") || issue.message.includes("operands cannot exceed"))
      )
        continue;
      issues.push(makeIssue("invalid_condition", path, issue.message));
    }
    const limitIssues: StudioConditionValidationIssue[] = [];
    addContractLimitIssues(value, [], 1, { value: 0 }, limitIssues);
    issues.push(...limitIssues);
    return { condition: undefined, issues, isValid: false };
  }

  if (issues.some((issue) => issue.code === "invalid_context"))
    return { condition: parsed.data, issues, isValid: false };

  const permissions = new Map(context.allowedOperands.map((entry) => [permissionKey(entry), entry]));
  const visit = (condition: ConditionNode, path: ConditionPath): void => {
    if (condition.kind === "not") {
      visit(condition.condition, [...path, "condition"]);
      return;
    }
    if (condition.kind === "all" || condition.kind === "any") {
      condition.conditions.forEach((child, index) => visit(child, [...path, "conditions", index]));
      return;
    }

    const checkOperand = (operand: ConditionOperand, key: "left" | "right"): OperandInfo | undefined => {
      const operandPath = [...path, key];
      if (operand.source === "value") {
        if (!context.allowLiteralValues)
          issues.push(makeIssue("literal_not_permitted", operandPath, "This host does not allow literal values"));
      } else if (!permissions.has(referenceKey(operand))) {
        issues.push(makeIssue("operand_not_permitted", operandPath, "This operand is not permitted by the host"));
      }
      return infoForOperand(operand, context);
    };

    const left = checkOperand(condition.left, "left");
    const right = condition.right === undefined ? undefined : checkOperand(condition.right, "right");
    if (context.allowedOperators !== undefined && !context.allowedOperators.includes(condition.operator))
      issues.push(makeIssue("operator_incompatible", [...path, "operator"], "This operator is not permitted by the host"));
    if (
      !unaryOperators.has(condition.operator) &&
      left !== undefined &&
      right !== undefined &&
      !operatorAcceptsOperands(condition.operator, left, right)
    )
      issues.push(makeIssue("operator_incompatible", [...path, "operator"], "This operator is not valid for the selected operand types"));
  };
  visit(parsed.data, []);
  return { condition: parsed.data, issues, isValid: issues.length === 0 };
}

const pathEquals = (left: ConditionPath, right: ConditionPath): boolean =>
  left.length === right.length && left.every((part, index) => part === right[index]);

const pathStartsWith = (path: ConditionPath, prefix: ConditionPath): boolean =>
  prefix.length <= path.length && prefix.every((part, index) => part === path[index]);

const hasLiteralAtPath = (condition: ConditionNode | undefined, path: ConditionPath): boolean => {
  const value = path.reduce<unknown>((current, part) => {
    if (Array.isArray(current) && typeof part === "number") return current[part];
    if (isRecord(current) && typeof part === "string") return current[part];
    return undefined;
  }, condition);
  return isRecord(value) && value.source === "value";
};

const withDraftIssues = (
  validation: StudioConditionValidation,
  draftIssues: readonly StudioConditionValidationIssue[],
): StudioConditionValidation => ({
  ...validation,
  issues: [...validation.issues, ...draftIssues],
  isValid: validation.isValid && draftIssues.length === 0,
});

const contextOperandToken = (permission: StudioConditionOperandPermission): string => permissionKey(permission);

const operandToken = (operand: ConditionOperand): string =>
  operand.source === "value" ? "value" : referenceKey(operand);

const displayRole = (role: StudioConditionOperandRole): string => roleLabels[role];

const errorForPath = (
  validation: StudioConditionValidation,
  path: ConditionPath,
): string | undefined =>
  validation.issues.find((issue) => pathEquals(issue.path, path))?.message;

const infoForExpectedLiteral = (
  operand: ConditionOperand,
  other: ConditionOperand | undefined,
  context: StudioConditionControlsContext,
  operator: ConditionOperator,
  side: "left" | "right",
): StudioConditionSemanticType | undefined => {
  const operandInfo = infoForOperand(operand, context);
  const otherInfo = other ? infoForOperand(other, context) : undefined;
  const otherType = otherInfo?.semanticType ??
    (other?.source === "value" ? semanticTypeForLiteral(other.value) : undefined);
  if (operator === "in" || operator === "not_in") {
    if (side === "right") return "text_collection";
    return otherInfo
      ? collectionElementType(
          otherInfo,
          operandInfo ? knownReferenceType(operandInfo) : undefined,
        ) ?? otherType
      : otherType;
  }
  if (operator === "contains" || operator === "not_contains") {
    if (side === "left") return operandInfo?.semanticType ?? "text_collection";
    return otherInfo
      ? collectionElementType(
          otherInfo,
          operandInfo ? knownReferenceType(operandInfo) : undefined,
        ) ?? "text"
      : "text";
  }
  return otherType ?? infoForOperand(operand, context)?.semanticType;
};

const literalInputValue = (value: JsonValue): string =>
  value === null ? "" : typeof value === "string" ? value : String(value);

type LiteralEditorProps = Readonly<{
  operand: Extract<ConditionOperand, { source: "value" }>;
  semanticType: StudioConditionSemanticType | undefined;
  collectionElementType?: Exclude<StudioConditionSemanticType, "text_collection" | "opaque_json">;
  path: ConditionPath;
  validation: StudioConditionValidation;
  onCommit: (value: JsonValue) => void;
  onInvalid: (message: string) => void;
}>;

function LiteralEditor({
  operand,
  semanticType,
  collectionElementType,
  path,
  validation,
  onCommit,
  onInvalid,
}: LiteralEditorProps) {
  const error = errorForPath(validation, path);
  const label = collectionElementType && collectionElementType !== "text"
    ? `Literal value (${collectionElementType.replaceAll("_", " ")} list, JSON array)`
    : `Literal value${semanticType ? ` (${semanticType.replaceAll("_", " ")})` : ""}`;

  if (collectionElementType && collectionElementType !== "text")
    return (
      <label>
        {label}
        <textarea
          key={`${pointerForPath(path)}:${JSON.stringify(operand.value)}`}
          aria-invalid={error !== undefined}
          defaultValue={JSON.stringify(Array.isArray(operand.value) ? operand.value : [], null, 2)}
          onBlur={(event) => {
            try {
              const parsed = jsonValueSchema.safeParse(JSON.parse(event.currentTarget.value));
              if (
                !parsed.success ||
                !Array.isArray(parsed.data) ||
                !parsed.data.every((value) => literalMatchesType(value, collectionElementType))
              )
                throw new Error("Enter a JSON array with items of the selected type");
              event.currentTarget.setCustomValidity("");
              onCommit(parsed.data);
            } catch {
              const message = "Enter a JSON array with items of the selected type";
              event.currentTarget.setCustomValidity(message);
              event.currentTarget.reportValidity();
              onInvalid(message);
            }
          }}
        />
        {error && <span role="alert">{error}</span>}
      </label>
    );
  if (semanticType === "boolean")
    return (
      <label>
        {label}
        <select
          aria-invalid={error !== undefined}
          value={operand.value === true ? "true" : "false"}
          onChange={(event) => onCommit(event.currentTarget.value === "true")}
        >
          <option value="true">True</option>
          <option value="false">False</option>
        </select>
        {error && <span role="alert">{error}</span>}
      </label>
    );

  if (semanticType === "number" || semanticType === "whole_number")
    return (
      <label>
        {label}
        <input
          key={`${pointerForPath(path)}:${JSON.stringify(operand.value)}`}
          aria-invalid={error !== undefined}
          type="text"
          inputMode={semanticType === "whole_number" ? "numeric" : "decimal"}
          defaultValue={typeof operand.value === "number" ? String(operand.value) : ""}
          onBlur={(event) => {
            const next = event.currentTarget.value;
            if (next === "") {
              event.currentTarget.setCustomValidity("");
              onCommit(null);
            } else {
              const numericValue = Number(next);
              const valid = Number.isFinite(numericValue) &&
                (semanticType !== "whole_number" || Number.isInteger(numericValue));
              if (valid) {
                event.currentTarget.setCustomValidity("");
                onCommit(numericValue);
              } else {
                const message = semanticType === "whole_number"
                  ? "Enter a whole number"
                  : "Enter a finite number";
                event.currentTarget.setCustomValidity(message);
                event.currentTarget.reportValidity();
                onInvalid(message);
              }
            }
          }}
        />
        {error && <span role="alert">{error}</span>}
      </label>
    );

  if (semanticType === "decimal_number")
    return (
      <label>
        {label}
        <input
          aria-invalid={error !== undefined}
          inputMode="decimal"
          type="text"
          value={literalInputValue(operand.value)}
          onChange={(event) => onCommit(event.currentTarget.value)}
        />
        {error && <span role="alert">{error}</span>}
      </label>
    );

  if (semanticType === "date")
    return (
      <label>
        {label}
        <input
          aria-invalid={error !== undefined}
          type="date"
          value={typeof operand.value === "string" ? operand.value : ""}
          onChange={(event) => onCommit(event.currentTarget.value)}
        />
        {error && <span role="alert">{error}</span>}
      </label>
    );

  if (semanticType === "date_time")
    return (
      <label>
        {label}
        <input
          aria-invalid={error !== undefined}
          type="datetime-local"
          value={typeof operand.value === "string" ? operand.value.slice(0, 16) : ""}
          onChange={(event) => {
            const next = event.currentTarget.value;
            const instant = next === "" ? null : new Date(next).toISOString();
            onCommit(instant);
          }}
        />
        {error && <span role="alert">{error}</span>}
      </label>
    );

  if (semanticType === "money") {
    const current = isRecord(operand.value) ? operand.value : {};
    const amount = typeof current.amount === "string" ? current.amount : "";
    const currency = typeof current.currency === "string" ? current.currency : "";
    return (
      <fieldset>
        <legend>{label}</legend>
        <label>
          Amount
          <input
            aria-invalid={error !== undefined}
            inputMode="decimal"
            type="text"
            value={amount}
            onChange={(event) => onCommit({ amount: event.currentTarget.value, currency })}
          />
        </label>
        <label>
          Currency
          <input
            aria-invalid={error !== undefined}
            maxLength={3}
            type="text"
            value={currency}
            onChange={(event) => onCommit({ amount, currency: event.currentTarget.value.toUpperCase() })}
          />
        </label>
        {error && <span role="alert">{error}</span>}
      </fieldset>
    );
  }

  if (semanticType === "text_collection")
    return (
      <label>
        {label} (one item per line)
        <textarea
          aria-invalid={error !== undefined}
          value={Array.isArray(operand.value) ? operand.value.map(String).join("\n") : ""}
          onChange={(event) => onCommit(event.currentTarget.value.split("\n"))}
        />
        {error && <span role="alert">{error}</span>}
      </label>
    );

  if (semanticType === "opaque_json" || semanticType === "record_reference" || semanticType === "organization_account_reference")
    return (
      <label>
        {label} (JSON value)
        <textarea
          key={`${pointerForPath(path)}:${JSON.stringify(operand.value)}`}
          aria-invalid={error !== undefined}
          defaultValue={JSON.stringify(operand.value)}
          onBlur={(event) => {
            try {
              const parsed = jsonValueSchema.safeParse(JSON.parse(event.currentTarget.value));
              if (!parsed.success) throw new Error("Enter a valid JSON value");
              event.currentTarget.setCustomValidity("");
              onCommit(parsed.data);
            } catch {
              const message = "Enter a valid JSON value";
              event.currentTarget.setCustomValidity(message);
              event.currentTarget.reportValidity();
              onInvalid(message);
            }
          }}
        />
        {error && <span role="alert">{error}</span>}
      </label>
    );

  return (
    <label>
      {label}
      <input
        aria-invalid={error !== undefined}
        type="text"
        value={typeof operand.value === "string" ? operand.value : ""}
        onChange={(event) => onCommit(event.currentTarget.value)}
      />
      {error && <span role="alert">{error}</span>}
    </label>
  );
}

type TreeEditorProps = Readonly<{
  condition: ConditionNode;
  context: StudioConditionControlsContext;
  validation: StudioConditionValidation;
  path: ConditionPath;
  remainingOperandCount: number;
  onReplace: (condition: ConditionNode, resolvedPath?: ConditionPath) => void;
  onRemove?: () => void;
  onInvalid: (issue: StudioConditionValidationIssue) => void;
}>;

function TreeEditor({
  condition,
  context,
  validation,
  path,
  remainingOperandCount,
  onReplace,
  onRemove,
  onInvalid,
}: TreeEditorProps) {
  if (condition.kind === "all" || condition.kind === "any") {
    const level = conditionLevelForPath(path);
    const canAddComparison = level + 1 <= conditionMaximumNestingDepth && remainingOperandCount > 0;
    const canAddGroup = level + 2 <= conditionMaximumNestingDepth && remainingOperandCount > 0;
    const addChild = (kind: "comparison" | "all" | "any" | "not") => {
      const leaf = createInitialStudioCondition(context);
      const addedDepth = kind === "comparison" ? 1 : 2;
      if (
        !leaf ||
        condition.conditions.length >= maximumGroupChildren ||
        remainingOperandCount <= 0 ||
        level + addedDepth > conditionMaximumNestingDepth
      )
        return;
      const child: ConditionNode =
        kind === "comparison"
          ? leaf
          : kind === "not"
            ? { kind: "not", condition: leaf }
            : { kind, conditions: [leaf] };
      onReplace({ ...condition, conditions: [...condition.conditions, child] });
    };
    return (
      <fieldset>
        <legend>{condition.kind === "all" ? "All conditions" : "Any condition"}</legend>
        <label>
          Group logic
          <select
            value={condition.kind}
            onChange={(event) => {
              const kind = event.currentTarget.value === "any" ? "any" : "all";
              onReplace({ kind, conditions: condition.conditions });
            }}
          >
            <option value="all">All must match</option>
            <option value="any">Any may match</option>
          </select>
        </label>
        {condition.conditions.map((child, index) => {
          const childPath = [...path, "conditions", index];
          return (
            <TreeEditor
              key={pointerForPath(childPath)}
              condition={child}
              context={context}
              validation={validation}
              path={childPath}
              remainingOperandCount={remainingOperandCount}
              onReplace={(next, resolvedPath) => {
                const conditions = [...condition.conditions];
                conditions[index] = next;
                onReplace({ ...condition, conditions }, resolvedPath);
              }}
              onRemove={() => {
                if (condition.conditions.length <= 1) return;
                onReplace({
                  ...condition,
                  conditions: condition.conditions.filter((_, childIndex) => childIndex !== index),
                }, path);
              }}
              onInvalid={onInvalid}
            />
          );
        })}
        <div>
          <button type="button" disabled={!canAddComparison || condition.conditions.length >= maximumGroupChildren || createInitialStudioCondition(context) === undefined} onClick={() => addChild("comparison")}>
            Add condition
          </button>
          <button type="button" disabled={!canAddGroup || condition.conditions.length >= maximumGroupChildren || createInitialStudioCondition(context) === undefined} onClick={() => addChild("all")}>
            Add all group
          </button>
          <button type="button" disabled={!canAddGroup || condition.conditions.length >= maximumGroupChildren || createInitialStudioCondition(context) === undefined} onClick={() => addChild("any")}>
            Add any group
          </button>
          <button type="button" disabled={!canAddGroup || condition.conditions.length >= maximumGroupChildren || createInitialStudioCondition(context) === undefined} onClick={() => addChild("not")}>
            Add not group
          </button>
          {onRemove && (
            <button type="button" onClick={onRemove}>
              Remove group
            </button>
          )}
        </div>
      </fieldset>
    );
  }

  if (condition.kind === "not")
    return (
      <fieldset>
        <legend>Not</legend>
        <TreeEditor
          condition={condition.condition}
          context={context}
          validation={validation}
          path={[...path, "condition"]}
          remainingOperandCount={remainingOperandCount}
          onReplace={(next, resolvedPath) => onReplace({ kind: "not", condition: next }, resolvedPath)}
          onInvalid={onInvalid}
        />
        <button type="button" onClick={() => onReplace(condition.condition, path)}>
          Remove not
        </button>
        {onRemove && (
          <button type="button" onClick={onRemove}>
            Remove group
          </button>
        )}
      </fieldset>
    );

  const leftInfo = infoForOperand(condition.left, context);
  const availableOperators = studioConditionOperatorsFor(condition.left, condition.right, context).filter(
    (option) =>
      option.arity === "unary" ||
      condition.right !== undefined ||
      remainingOperandCount > 0,
  );
  const currentOperatorAvailable = leftInfo !== undefined && (
    unaryOperators.has(condition.operator) ||
    (condition.right !== undefined && operatorAcceptsOperands(
      condition.operator,
      leftInfo,
      infoForOperand(condition.right, context),
    ))
  );
  const operatorIssue = errorForPath(validation, [...path, "operator"]);
  const compatibleOperand = (side: "left" | "right", candidate: ConditionOperand): boolean => {
    if (unaryOperators.has(condition.operator)) return side === "left";
    const other = side === "left" ? condition.right : condition.left;
    if (!other) return false;
    const left = infoForOperand(side === "left" ? candidate : other, context);
    const right = infoForOperand(side === "right" ? candidate : other, context);
    return left !== undefined && right !== undefined &&
      operatorAcceptsOperands(condition.operator, left, right);
  };
  const literalChoice = (side: "left" | "right"): ConditionOperand | undefined => {
    if (!context.allowLiteralValues) return undefined;
    const other = side === "left" ? condition.right : condition.left;
    const type = other ? infoForOperand(other, context)?.semanticType : undefined;
    const candidates: ConditionOperand[] = [
      literalOperand(type),
      { source: "value", value: null },
      { source: "value", value: [] },
      literalOperand("text"),
    ];
    return candidates.find((candidate) => compatibleOperand(side, candidate));
  };
  const changeOperand = (side: "left" | "right", token: string) => {
    const selected = token === "value"
      ? literalChoice(side)
      : context.allowedOperands.find(
          (entry) => contextOperandToken(entry) === token && compatibleOperand(side, entry.operand),
        )?.operand;
    if (!selected) return;
    if (side === "left") onReplace({ ...condition, left: selected }, [...path, side]);
    else onReplace({ ...condition, right: selected }, [...path, side]);
  };

  const literalEditor = (
    operand: ConditionOperand | undefined,
    other: ConditionOperand | undefined,
    side: "left" | "right",
  ) => {
    if (!context.allowLiteralValues || !operand || operand.source !== "value") return null;
    const type = infoForExpectedLiteral(operand, other, context, condition.operator, side);
    const otherInfo = other ? infoForOperand(other, context) : undefined;
    const collectionType =
      (condition.operator === "in" || condition.operator === "not_in") && side === "right" && otherInfo
        ? isCollectionElementType(otherInfo.semanticType)
          ? otherInfo.semanticType
          : undefined
        : undefined;
    const pathToOperand = [...path, side];
    return (
      <LiteralEditor
        operand={operand}
        semanticType={type}
        collectionElementType={collectionType}
        path={pathToOperand}
        validation={validation}
        onCommit={(value) => {
          const replacement: ConditionOperand = { source: "value", value };
          if (side === "left") onReplace({ ...condition, left: replacement }, pathToOperand);
          else onReplace({ ...condition, right: replacement }, pathToOperand);
        }}
        onInvalid={(message) => {
          const issue = makeIssue("invalid_literal", pathToOperand, message);
          onInvalid(issue);
        }}
      />
    );
  };

  const operandSelector = (side: "left" | "right") => {
    const operand = side === "left" ? condition.left : condition.right;
    const other = side === "left" ? condition.right : condition.left;
    if (!operand) return null;
    const pathToOperand = [...path, side];
    const operandError = errorForPath(validation, pathToOperand);
    const referenceOptions = context.allowedOperands.filter((option) =>
      compatibleOperand(side, option.operand),
    );
    const selectableLiteral = literalChoice(side);
    const currentSelectable = operand.source === "value"
      ? selectableLiteral !== undefined
      : referenceOptions.some((option) => contextOperandToken(option) === operandToken(operand));
    return (
      <fieldset>
        <legend>{side === "left" ? "Left operand" : "Right operand"}</legend>
        <label>
          Operand source
        <select
          aria-invalid={operandError !== undefined}
          value={operandToken(operand)}
          onChange={(event) => changeOperand(side, event.currentTarget.value)}
        >
          {!currentSelectable && (
            <option value={operandToken(operand)} disabled>
              Current operand (not available)
            </option>
          )}
          {referenceOptions.map((option, index) => (
            <option key={`${contextOperandToken(option)}:${index}`} value={contextOperandToken(option)}>
              {option.label} ({displayRole(option.role)})
            </option>
          ))}
          {selectableLiteral && <option value="value">Literal value</option>}
        </select>
        </label>
        {operandError && <span role="alert">{operandError}</span>}
        {literalEditor(operand, other, side)}
      </fieldset>
    );
  };

  const rightOptions = availableOperators;
  const rightForOperator = (operator: ConditionOperator): ConditionOperand | undefined =>
    defaultRightForOperator(operator, condition.left, context);

  return (
    <fieldset>
      <legend>Comparison</legend>
      {operandSelector("left")}
      <label>
        Operator
        <select
          aria-invalid={operatorIssue !== undefined || !currentOperatorAvailable}
          value={condition.operator}
          onChange={(event) => {
            const operator = event.currentTarget.value as ConditionOperator;
            if (unaryOperators.has(operator)) {
              onReplace({ kind: "comparison", operator, left: condition.left });
              return;
            }
            const existingRight = condition.right;
            const candidate = existingRight && operatorAcceptsOperands(
              operator,
              leftInfo ?? { source: "value", semanticType: undefined, literal: null },
              infoForOperand(existingRight, context),
            ) ? existingRight : rightForOperator(operator);
            if (!candidate) return;
            onReplace({ kind: "comparison", operator, left: condition.left, right: candidate });
          }}
        >
          {!currentOperatorAvailable && (
            <option value={condition.operator} disabled>
              {operatorOptions.find((option) => option.operator === condition.operator)?.label ?? condition.operator} (not valid for these operands)
            </option>
          )}
          {rightOptions.map((option) => (
            <option key={option.operator} value={option.operator}>
              {option.label}
            </option>
          ))}
        </select>
        {operatorIssue && <span role="alert">{operatorIssue}</span>}
      </label>
      {!unaryOperators.has(condition.operator) && (
        <>
          {operandSelector("right")}
        </>
      )}
      {onRemove && (
        <button type="button" onClick={onRemove}>
          Remove condition
        </button>
      )}
      <button
        type="button"
        disabled={createInitialStudioCondition(context) === undefined}
        onClick={() => {
          const replacement = createInitialStudioCondition(context);
          if (replacement) onReplace(replacement, path);
        }}
      >
        Reset comparison
      </button>
    </fieldset>
  );
}

export type StudioConditionControlsProps = Readonly<{
  value?: ConditionNode;
  context: StudioConditionControlsContext;
  label?: string;
  /** Receives only the current shared condition tree; located issues remain separate. */
  onChange: (condition: ConditionNode | undefined, validation: StudioConditionValidation) => void;
}>;

/** Accessible, reusable authoring controls for the current shared Rule condition tree. */
export function StudioConditionControls({
  value,
  context,
  label = "Condition controls",
  onChange,
}: StudioConditionControlsProps) {
  const [draftIssues, setDraftIssues] = useState<readonly StudioConditionValidationIssue[]>([]);
  const baseValidation = validateStudioCondition(value, context);
  const activeDraftIssues = draftIssues.filter((issue) => hasLiteralAtPath(baseValidation.condition, issue.path));
  const validation = withDraftIssues(baseValidation, activeDraftIssues);
  const emit = (next: ConditionNode | undefined, resolvedPath?: ConditionPath) => {
    const nextValidation = validateStudioCondition(next, context);
    const remainingIssues = activeDraftIssues.filter((issue) =>
      (resolvedPath === undefined || !pathStartsWith(issue.path, resolvedPath)) &&
      hasLiteralAtPath(nextValidation.condition, issue.path),
    );
    setDraftIssues(remainingIssues);
    onChange(nextValidation.condition, withDraftIssues(nextValidation, remainingIssues));
  };
  const current = validation.condition;
  const initial = createInitialStudioCondition(context);
  const contextIsInvalid = validation.issues.some((issue) => issue.code === "invalid_context");
  const validationSummary = validation.issues.length > 0 && (
    <ul aria-live="polite" role="status">
      {validation.issues.map((issue, index) => (
        <li key={`${issue.pointer}:${issue.code}:${index}`}>
          <strong>{issue.pointer || "Condition"}:</strong> {issue.message}
        </li>
      ))}
    </ul>
  );

  return (
    <section aria-label={label}>
      {validationSummary}
      {contextIsInvalid ? (
        <p role="alert">Condition controls need a valid host permission context.</p>
      ) : !current ? (
        <div>
          <p>No condition has been configured.</p>
          <button type="button" disabled={!initial} onClick={() => emit(initial)}>
            Start with a condition
          </button>
        </div>
      ) : (
        <>
          <TreeEditor
            condition={current}
            context={context}
            validation={validation}
            path={[]}
            remainingOperandCount={
              conditionMaximumOperandCount - conditionOperandCount(current)
            }
            onReplace={emit}
            onInvalid={(issue) => {
              const nextValidation = validateStudioCondition(current, context);
              const issues = [...activeDraftIssues.filter((entry) => !pathEquals(entry.path, issue.path)), issue];
              setDraftIssues(issues);
              onChange(nextValidation.condition, withDraftIssues(nextValidation, issues));
            }}
          />
          <div>
            <button
              type="button"
              disabled={conditionDepth(current) >= conditionMaximumNestingDepth}
              onClick={() => emit({ kind: "all", conditions: [current] })}
            >
              Wrap in all group
            </button>
            <button
              type="button"
              disabled={conditionDepth(current) >= conditionMaximumNestingDepth}
              onClick={() => emit({ kind: "any", conditions: [current] })}
            >
              Wrap in any group
            </button>
            {current.kind !== "not" && (
              <button
                type="button"
                disabled={conditionDepth(current) >= conditionMaximumNestingDepth}
                onClick={() => emit({ kind: "not", condition: current })}
              >
                Negate condition
              </button>
            )}
            {current.kind === "not" && (
              <button type="button" onClick={() => emit(current.condition)}>
                Remove not
              </button>
            )}
            {(current.kind === "all" || current.kind === "any") && current.conditions.length === 1 && (
              <button
                type="button"
                onClick={() => {
                  const onlyChild = current.conditions[0];
                  if (onlyChild) emit(onlyChild);
                }}
              >
                Remove group
              </button>
            )}
            <button type="button" onClick={() => emit(undefined)}>
              Clear condition
            </button>
          </div>
        </>
      )}
      {validation.condition && !validation.isValid && (
        <p role="alert">Resolve the located condition issues before saving.</p>
      )}
    </section>
  );
}
