import {
  builderKeySchema,
  conditionMaximumNestingDepth,
  conditionMaximumOperandCount,
  conditionNodeSchema,
  dateValueSchema,
  exactDecimalTextSchema,
  fieldIdSchema,
  jsonValueSchema,
  moduleFieldSchema,
  moneyValueSchema,
  organizationAccountIdSchema,
  personLinkValueSchema,
  recordLinkValueSchema,
  type ConditionNode,
  type JsonValue,
  type ModuleField,
  isRecord,
} from "@vortex/platform/schema";
import { formatIsoDate } from "../display/date-format";


type ComparisonCondition = Extract<ConditionNode, { kind: "comparison" }>;
export type ConditionOperand = ComparisonCondition["left"];
type FieldOperand = Extract<ConditionOperand, { source: "field" }>;
type ParameterOperand = Extract<ConditionOperand, { source: "parameter" }>;
type FieldOperandPermission = Extract<StudioConditionOperandPermission, { field: ModuleField }>;

export const isComparisonCondition = (condition: ConditionNode): condition is ComparisonCondition =>
  condition.kind === "comparison";

const isFieldOperandPermission = (
  permission: StudioConditionOperandPermission,
): permission is FieldOperandPermission => "field" in permission;

/** The semantic types used by the current Rule  field and parameter contracts. */
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

/** Parameter types accepted by Rule . Host-only values use the same parameter source. */
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
 * trusted context use the existing `parameter` operand and must have a matching Rule
 * declaration; current Module fields use the existing `field` operand and their Module metadata.
 */
export type StudioConditionOperandPermission =
  | Readonly<{
      operand: FieldOperand;
      field: ModuleField;
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
  /** The source fields the owning host declared for this Rule  evaluation context. */
  declaredFieldIds: readonly string[];
  /** Exact Rule  declarations resolve the types of every permitted parameter operand. */
  parameterDeclarations: readonly StudioConditionParameterDeclaration[];
  /** Literal values are opt-in so each host can apply its own authoring policy. */
  allowLiteralValues: boolean;
  /** An omitted operator list permits the current Rule  operator catalogue. */
  allowedOperators?: readonly StudioConditionOperator[];
}>;

export type StudioConditionOperator = ComparisonCondition["operator"];
export type StudioConditionOperatorOption = Readonly<{
  operator: StudioConditionOperator;
  label: string;
  arity: "unary" | "binary";
}>;

export type ConditionOperator = StudioConditionOperator;

export const unaryOperators = new Set<ConditionOperator>(["is_empty", "is_not_empty"]);
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
export const operatorOptions: readonly StudioConditionOperatorOption[] = (
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
export const maximumGroupChildren = 50;

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

export type ConditionPath = readonly (string | number)[];

const roleLabels: Readonly<Record<StudioConditionOperandRole, string>> = {
  current_field: "Current fields",
  previous_field: "Previous values",
  declared_input: "Declared inputs",
  event_value: "Event values",
  variable: "Variables",
  trusted_account_context: "Trusted account context",
  host_context: "Host context",
};

export const pointerForPath = (path: ConditionPath): string =>
  path.length === 0
    ? ""
    : `/${path.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;

export const makeIssue = (
  code: StudioConditionValidationIssue["code"],
  path: ConditionPath,
  message: string,
): StudioConditionValidationIssue => ({
  code,
  pointer: pointerForPath(path),
  path,
  message,
});

export const conditionOperandCount = (condition: ConditionNode): number => {
  if (isComparisonCondition(condition)) return condition.right === undefined ? 1 : 2;
  if (condition.kind === "not") return conditionOperandCount(condition.condition);
  return condition.conditions.reduce((count, child) => count + conditionOperandCount(child), 0);
};

export const conditionDepth = (condition: ConditionNode): number => {
  if (isComparisonCondition(condition)) return 1;
  if (condition.kind === "not") return 1 + conditionDepth(condition.condition);
  return 1 + Math.max(...condition.conditions.map(conditionDepth));
};

export const conditionLevelForPath = (path: ConditionPath): number =>
  1 + path.filter((part) => part === "conditions" || part === "condition").length;

const referenceKey = (operand: Exclude<ConditionOperand, { source: "value" }>): string =>
  operand.source === "field" ? `field:${operand.fieldId}` : `parameter:${operand.key}`;

const permissionKey = (permission: StudioConditionOperandPermission): string =>
  referenceKey(permission.operand);

const semanticTypeForField = (field: ModuleField): StudioConditionSemanticType => {
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

    if (isFieldOperandPermission(permission)) {
      const parsedField = moduleFieldSchema.safeParse(permission.field);
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
        issues.push(makeIssue("invalid_context", ["allowedOperands", index], "A parameter must match a Rule  declaration"));
      if (
        permission.role === "trusted_account_context" &&
        declaredType !== "organization_account_reference"
      )
        issues.push(makeIssue("invalid_context", ["allowedOperands", index], "Trusted account context must use its declared account type"));
    }
  }
  return issues;
};

export const infoForOperand = (
  operand: ConditionOperand,
  context: StudioConditionControlsContext,
): OperandInfo | undefined => {
  if (operand.source === "value")
    return { source: "value", literal: operand.value, semanticType: semanticTypeForLiteral(operand.value) };
  const permission = context.allowedOperands.find(
    (candidate) => permissionKey(candidate) === referenceKey(operand),
  );
  if (!permission) return undefined;
  if (!isFieldOperandPermission(permission)) {
    const declaredType = context.parameterDeclarations.find(
      (declaration) => declaration.key === permission.operand.key,
    )?.type;
    return declaredType
      ? { source: "reference", semanticType: semanticTypeForParameter(declaredType) }
      : undefined;
  }
  return {
    source: "reference",
    semanticType: semanticTypeForField(permission.field),
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
  if (!dateValueSchema.safeParse(value.slice(0, 10)).success) return false;
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
    if (dateValueSchema.safeParse(value).success) return "date";
    if (isValidInstant(value)) return "date_time";
    return "text";
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
    return "text_collection";
  return "opaque_json";
};

export const literalMatchesType = (value: JsonValue, type: StudioConditionSemanticType): boolean => {
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
        exactDecimalTextSchema.safeParse(value).success ||
        (typeof value === "number" && Number.isInteger(value))
      );
    case "money":
      return moneyValueSchema.safeParse(value).success;
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return dateValueSchema.safeParse(value).success;
    case "date_time":
      return isValidInstant(value);
    case "text_collection":
      return Array.isArray(value) && value.every(isValidText);
    case "opaque_json":
      return jsonValueSchema.safeParse(value).success;
    case "record_reference":
      return recordLinkValueSchema.safeParse(value).success;
    case "organization_account_reference":
      return (
        organizationAccountIdSchema.safeParse(value).success ||
        personLinkValueSchema.safeParse(value).success
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
  (typeof value === "string" && exactDecimalTextSchema.safeParse(value).success);

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

export const isCollectionElementType = (
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

export const operatorAcceptsOperands = (
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
    const leftMoney = moneyValueSchema.safeParse(left.literal);
    const rightMoney = moneyValueSchema.safeParse(right.literal);
    if (leftMoney.success && rightMoney.success &&
      leftMoney.data.currency !== rightMoney.data.currency) return false;
  }
  return type !== undefined && orderableTypes.has(type);
};

export const defaultLiteralForType = (type: StudioConditionSemanticType | undefined): JsonValue | undefined => {
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

export const literalOperand = (type: StudioConditionSemanticType | undefined): ConditionOperand => ({
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
 * Filters editor options from the shared operator vocabulary and Rule  semantic types.
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

export const defaultRightForOperator = (
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
    if (!isComparisonCondition(condition)) return;

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

export const pathEquals = (left: ConditionPath, right: ConditionPath): boolean =>
  left.length === right.length && left.every((part, index) => part === right[index]);

export const pathStartsWith = (path: ConditionPath, prefix: ConditionPath): boolean =>
  prefix.length <= path.length && prefix.every((part, index) => part === path[index]);

export const hasLiteralAtPath = (condition: ConditionNode | undefined, path: ConditionPath): boolean => {
  const value = path.reduce<unknown>((current, part) => {
    if (Array.isArray(current) && typeof part === "number") return current[part];
    if (isRecord(current) && typeof part === "string") return current[part];
    return undefined;
  }, condition);
  return isRecord(value) && value.source === "value";
};

export const withDraftIssues = (
  validation: StudioConditionValidation,
  draftIssues: readonly StudioConditionValidationIssue[],
): StudioConditionValidation => ({
  ...validation,
  issues: [...validation.issues, ...draftIssues],
  isValid: validation.isValid && draftIssues.length === 0,
});

export const contextOperandToken = (permission: StudioConditionOperandPermission): string => permissionKey(permission);

export const operandToken = (operand: ConditionOperand): string =>
  operand.source === "value" ? "value" : referenceKey(operand);

const describeOperand = (
  operand: ConditionOperand,
  context: StudioConditionControlsContext,
): string => {
  if (operand.source === "value") return JSON.stringify(operand.value) ?? "null";
  const permission = context.allowedOperands.find(
    (candidate) => permissionKey(candidate) === referenceKey(operand),
  );
  return permission ? permission.label : "Unavailable operand";
};

export const describeCondition = (
  condition: ConditionNode,
  context: StudioConditionControlsContext,
): string => {
  if (isComparisonCondition(condition)) {
    const left = describeOperand(condition.left, context);
    const operator = operatorLabels[condition.operator];
    return condition.right === undefined
      ? `${left} ${operator}`
      : `${left} ${operator} ${describeOperand(condition.right, context)}`;
  }
  if (condition.kind === "not")
    return `not (${describeCondition(condition.condition, context)})`;
  const joiningWord = condition.kind === "all" ? " and " : " or ";
  return `(${condition.conditions.map((child) => describeCondition(child, context)).join(joiningWord)})`;
};

export const displayRole = (role: StudioConditionOperandRole): string => roleLabels[role];

export const errorForPath = (
  validation: StudioConditionValidation,
  path: ConditionPath,
): string | undefined =>
  validation.issues.find((issue) => pathEquals(issue.path, path))?.message;

export const infoForExpectedLiteral = (
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

export const literalInputValue = (value: JsonValue): string =>
  value === null ? "" : typeof value === "string" ? value : String(value);

export const localDateTimeInputValue = (value: JsonValue, timeZone: string): string => {
  if (typeof value !== "string" || !isValidInstant(value)) return "";
  return formatIsoDate(value, { timeZone }, "input") ?? "";
};
