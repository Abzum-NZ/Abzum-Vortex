import {
  conditionFieldType,
  typedValueMatchesType,
  fieldValueMatches,
  semanticTypeForLiteral as naturalLiteralType,
  conditionSharedType,
  collectionElementType as sharedCollectionElementType,
  operatorAcceptsOperands,
  type ConditionValueType,
  type OperandInfo,
} from "./condition-types";
import {
  exactDecimalTextSchema,
  moneyValueSchema,
  organizationAccountIdSchema,
  parseExactDecimal,
  recordLinkValueSchema,
  type ExactDecimal,
  type FlowFormula,
  type JsonValue,
  type ModuleField,
} from "../schema";
import {
  TypedConditionEvaluationError,
  type TypedConditionEvaluationErrorReason,
} from "./typed-condition-error";
import { evaluateFlowFormula } from "./flow-formula";
import type {
  ResolvedTypedConditionNode,
  ResolvedTypedConditionOperand as CoreResolvedTypedConditionOperand,
} from "./typed-condition-core";

export type SemanticType = ConditionValueType;

export type ResolvedTypedConditionOperand = CoreResolvedTypedConditionOperand<SemanticType> &
  Readonly<{ missing?: boolean }>;

const refuse = (reason: TypedConditionEvaluationErrorReason): never => {
  throw new TypedConditionEvaluationError(reason);
};

export const semanticTypeForField = (field: ModuleField): SemanticType =>
  conditionFieldType(field) ?? refuse("input_refused");
export const valueMatchesSemanticType = (value: JsonValue, type: SemanticType): boolean =>
  value === null || typedValueMatchesType(value, type);

export const valueMatchesField = (value: JsonValue, field: ModuleField): boolean =>
  conditionFieldType(field) !== undefined &&
  (value === null || fieldValueMatches(value, field, "canonical"));

const exactFromValue = (value: JsonValue): ExactDecimal | undefined => {
  if (typeof value === "string") {
    if (!exactDecimalTextSchema.safeParse(value).success) return undefined;
    return parseExactDecimal(value);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return undefined;
  return parseExactDecimal(BigInt(value).toString());
};

const operandInfo = (operand: ResolvedTypedConditionOperand): OperandInfo => ({
  source: operand.literal === undefined ? "reference" : "value",
  semanticType:
    operand.type ??
    (operand.literal === undefined ? undefined : naturalLiteralType(operand.literal)),
  ...(operand.literal === undefined ? {} : { literal: operand.literal }),
});
const sharedType = (
  left: ResolvedTypedConditionOperand,
  right: ResolvedTypedConditionOperand,
): SemanticType | undefined => conditionSharedType(operandInfo(left), operandInfo(right));
const collectionElementType = (
  operand: ResolvedTypedConditionOperand,
  expectedType?: SemanticType,
): SemanticType | undefined => sharedCollectionElementType(operandInfo(operand), expectedType);

const recordReferenceIdentity = (value: JsonValue): string | undefined => {
  const parsed = recordLinkValueSchema.safeParse(value);
  return parsed.success
    ? `${parsed.data.recordTypeId.toLowerCase()}/${parsed.data.recordId.toLowerCase()}`
    : undefined;
};

const organizationAccountIdentity = (value: JsonValue): string | undefined => {
  const direct = organizationAccountIdSchema.safeParse(value);
  return direct.success ? direct.data.toLowerCase() : undefined;
};

const moneyParts = (
  value: JsonValue,
): Readonly<{ amount: ExactDecimal; currency: string }> | undefined => {
  const parsed = moneyValueSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const amount = exactFromValue(parsed.data.amount);
  return amount === undefined ? undefined : { amount, currency: parsed.data.currency };
};

export const evaluateResolvedTypedCondition = <TSourceOperand>(
  condition: ResolvedTypedConditionNode<TSourceOperand>,
  resolveOperand: (entry: TSourceOperand) => ResolvedTypedConditionOperand,
): boolean => {
  const validate = (node: ResolvedTypedConditionNode<TSourceOperand>): void => {
    if (node.kind === "all" || node.kind === "any") {
      node.conditions.forEach(validate);
      return;
    }
    if (node.kind === "not") {
      validate(node.condition);
      return;
    }
    if (node.kind !== "comparison") return refuse("operator_refused");
    const operator = node.operator;
    const left = resolveOperand(node.left);
    const right = node.right === undefined ? undefined : resolveOperand(node.right);
    if (operator === "is_empty" || operator === "is_not_empty") return;
    const binaryRight = right ?? refuse("input_refused");
    if (left.missing || binaryRight.missing) refuse("input_refused");
    if (!operatorAcceptsOperands(operator, operandInfo(left), operandInfo(binaryRight)))
      refuse("operator_refused");
  };
  validate(condition);

  const formulaLiteral = (
    operand: ResolvedTypedConditionOperand,
    typeOverride?: SemanticType,
  ): FlowFormula => {
    const sourceType =
      typeOverride ??
      operand.type ??
      (operand.literal === undefined ? undefined : naturalLiteralType(operand.literal)) ??
      "opaque_json";
    let type: string = sourceType;
    let value = operand.value;
    if (type === "decimal_number" && typeof value === "number") value = String(value);
    else if (type === "record_reference") {
      type = "text";
      if (value !== null) value = recordReferenceIdentity(value) ?? value;
    } else if (type === "organization_account_reference") {
      type = "text";
      if (value !== null) value = organizationAccountIdentity(value) ?? value;
    } else if (type === "text_collection") type = "several_choices";
    else if (type === "opaque_json") type = "json";
    return {
      op: "literal",
      type,
      value,
    } as unknown as FlowFormula;
  };

  const combine = (op: "and" | "or", formulas: readonly FlowFormula[]): FlowFormula => {
    if (formulas.length === 0) return { op: "literal", type: "yes_no", value: op === "and" };
    if (formulas.length === 1) return formulas[0]!;
    if (formulas.length <= 20) return { op, args: [...formulas] };
    const groups: FlowFormula[] = [];
    for (let index = 0; index < formulas.length; index += 20)
      groups.push(combine(op, formulas.slice(index, index + 20)));
    return { op, args: groups };
  };

  const toFormula = (node: ResolvedTypedConditionNode<TSourceOperand>): FlowFormula => {
    if (node.kind === "all" || node.kind === "any")
      return combine(node.kind === "all" ? "and" : "or", node.conditions.map(toFormula));
    if (node.kind === "not") return { op: "not", arg: toFormula(node.condition) };
    if (node.kind !== "comparison") return refuse("operator_refused");

    const left = resolveOperand(node.left);
    let leftFormula = formulaLiteral(left);
    if (node.operator === "is_empty" || node.operator === "is_not_empty") {
      if (left.missing || Array.isArray(left.value)) {
        const empty = left.missing === true;
        return {
          op: "literal",
          type: "yes_no",
          value: node.operator === "is_empty" ? empty : !empty,
        };
      }
      return { op: node.operator, arg: leftFormula };
    }

    const right = node.right === undefined ? refuse("input_refused") : resolveOperand(node.right);
    let rightFormula = formulaLiteral(right);
    const comparisons = {
      equals: "eq",
      not_equals: "neq",
      greater_than: "gt",
      greater_than_or_equal: "gte",
      less_than: "lt",
      less_than_or_equal: "lte",
      contains: "contains",
    } as const;
    if (
      ["greater_than", "greater_than_or_equal", "less_than", "less_than_or_equal"].includes(
        node.operator,
      ) &&
      (left.value === null || right.value === null)
    )
      return { op: "literal", type: "yes_no", value: false };
    if (node.operator === "contains" || node.operator === "not_contains") {
      let contains: FlowFormula;
      if (left.value === null || right.value === null)
        contains = { op: "literal", type: "yes_no", value: false };
      else if (Array.isArray(left.value)) {
        const elementType = collectionElementType(left, right.type);
        if (elementType === undefined) refuse("operator_refused");
        contains =
          left.value.length === 0
            ? { op: "literal", type: "yes_no", value: false }
            : {
                op: "in",
                value: formulaLiteral(right, elementType),
                options: left.value.map((entry) =>
                  formulaLiteral({ value: entry, literal: entry }, elementType),
                ),
              };
      } else contains = { op: "contains", left: leftFormula, right: rightFormula };
      return node.operator === "not_contains" ? { op: "not", arg: contains } : contains;
    }
    if (node.operator === "in" || node.operator === "not_in") {
      let membership: FlowFormula;
      if (left.value === null || right.value === null)
        membership = { op: "literal", type: "yes_no", value: false };
      else if (Array.isArray(right.value)) {
        const elementType = collectionElementType(right, left.type);
        if (elementType === undefined) refuse("operator_refused");
        membership =
          right.value.length === 0
            ? { op: "literal", type: "yes_no", value: false }
            : {
                op: "in",
                value: formulaLiteral(left, elementType),
                options: right.value.map((entry) =>
                  formulaLiteral({ value: entry, literal: entry }, elementType),
                ),
              };
      } else if (right.type === "text_collection") {
        membership = { op: "contains", left: rightFormula, right: leftFormula };
      } else {
        membership = { op: "in", value: leftFormula, options: [rightFormula] };
      }
      return node.operator === "not_in" ? { op: "not", arg: membership } : membership;
    }
    const comparisonType = sharedType(left, right);
    if (
      comparisonType === "money" &&
      left.value !== null &&
      right.value !== null &&
      moneyParts(left.value)!.currency !== moneyParts(right.value)!.currency
    )
      return { op: "literal", type: "yes_no", value: node.operator === "not_equals" };
    if (comparisonType !== undefined) {
      leftFormula = formulaLiteral(left, comparisonType);
      rightFormula = formulaLiteral(right, comparisonType);
    }
    return {
      op: comparisons[node.operator as keyof typeof comparisons],
      left: leftFormula,
      right: rightFormula,
    } as FlowFormula;
  };

  const result = evaluateFlowFormula(toFormula(condition), {
    now: "1970-01-01T00:00:00.000Z",
    reference: () => undefined,
  });
  if (result?.type !== "yes_no" || typeof result.value !== "boolean")
    return refuse("operator_refused");
  return result.value;
};
