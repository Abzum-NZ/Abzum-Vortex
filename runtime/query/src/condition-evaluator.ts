import "server-only";

import type { ConditionNode, FieldDefinition, FieldId, JsonValue } from "@vortex/contracts";
import {
  compareTypedValues,
  deriveFieldSemanticType,
  typedValuesEqual,
  valueMatchesSemanticType,
  type QuerySemanticType,
} from "./field-semantics";

export const queryConditionRefusalReasons = [
  "field_unreadable",
  "field_value_missing",
  "parameter_value_missing",
  "operator_unsupported",
  "operand_type_mismatch",
] as const;
export type QueryConditionRefusalReason = (typeof queryConditionRefusalReasons)[number];

export class QueryConditionRefusalError extends Error {
  constructor(readonly reason: QueryConditionRefusalReason) {
    super(`vortex.query.condition_${reason}`);
    this.name = "QueryConditionRefusalError";
  }
}

const refuse = (reason: QueryConditionRefusalReason): never => {
  throw new QueryConditionRefusalError(reason);
};

type ConditionOperand =
  | Readonly<{ source: "field"; fieldId: string }>
  | Readonly<{ source: "value"; value: JsonValue }>
  | Readonly<{ source: "parameter"; key: string }>;

type ComparisonNode = Extract<ConditionNode, { kind: "comparison" }>;

type Operand = Readonly<{ type?: QuerySemanticType; literal?: JsonValue; value: JsonValue }>;

export type QueryConditionContext = Readonly<{
  /** Every field this condition may reference, keyed by field id; must already be within bounds. */
  fieldsById: ReadonlyMap<FieldId, FieldDefinition>;
  /** The candidate row's values, keyed by field id, already limited to `fieldsById`. */
  fieldValues: Readonly<Record<string, JsonValue>>;
  /** Typed input values keyed by input key, already validated against the descriptor's inputs. */
  parameterValues: Readonly<Record<string, JsonValue>>;
}>;

const naturalLiteralType = (value: JsonValue): QuerySemanticType | undefined => {
  if (value === null) return undefined;
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isSafeInteger(value) ? "number_integer" : undefined;
  if (typeof value === "string") return "text";
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
    return "text_collection";
  return undefined;
};

const literalMatchesType = (value: JsonValue, type: QuerySemanticType): boolean =>
  value === null || valueMatchesSemanticType(value, type);

const sharedType = (left: Operand, right: Operand): QuerySemanticType | undefined => {
  if (left.type && right.type) return left.type === right.type ? left.type : undefined;
  if (left.type)
    return right.literal !== undefined && literalMatchesType(right.literal, left.type)
      ? left.type
      : undefined;
  if (right.type)
    return left.literal !== undefined && literalMatchesType(left.literal, right.type)
      ? right.type
      : undefined;
  if (left.literal === undefined || right.literal === undefined) return undefined;
  if (left.literal === null && right.literal === null) return undefined;
  const leftType = left.literal === null ? undefined : naturalLiteralType(left.literal);
  const rightType = right.literal === null ? undefined : naturalLiteralType(right.literal);
  if (left.literal === null) return rightType;
  if (right.literal === null) return leftType;
  return leftType === rightType ? leftType : undefined;
};

const collectionElementType = (
  operand: Operand,
  expectedType: QuerySemanticType | undefined,
): QuerySemanticType | undefined => {
  if (operand.type === "text_collection") return "text";
  if (Array.isArray(operand.literal)) {
    if (operand.literal.length === 0) return expectedType;
    return operand.literal.every((entry) => typeof entry === "string") ? "text" : undefined;
  }
  return undefined;
};

const resolveOperand =
  (context: QueryConditionContext) =>
  (entry: ConditionOperand): Operand => {
    if (entry.source === "field") {
      const fieldId = entry.fieldId as FieldId;
      const field = context.fieldsById.get(fieldId);
      if (!field) refuse("field_unreadable");
      if (!Object.prototype.hasOwnProperty.call(context.fieldValues, fieldId))
        refuse("field_value_missing");
      const type = deriveFieldSemanticType(field);
      const value = context.fieldValues[fieldId]!;
      if (value !== null && !valueMatchesSemanticType(value, type)) refuse("operand_type_mismatch");
      return { type, value };
    }
    if (entry.source === "parameter") {
      if (!Object.prototype.hasOwnProperty.call(context.parameterValues, entry.key))
        refuse("parameter_value_missing");
      const value = context.parameterValues[entry.key]!;
      return { literal: value, value };
    }
    return { literal: entry.value, value: entry.value };
  };

/**
 * Evaluates one descriptor-fixed filter condition against one candidate row.
 * The condition tree, its field references and its operators were already
 * validated at Module publish time (#547); this only binds live values and
 * refuses rather than guesses when a bound value does not match its declared
 * shape.
 */
export const evaluateQueryCondition = (
  condition: ConditionNode,
  context: QueryConditionContext,
): boolean => {
  const resolve = resolveOperand(context);

  const validateComparison = (node: ComparisonNode): void => {
    const left = resolve(node.left as ConditionOperand);
    if (node.operator === "is_empty" || node.operator === "is_not_empty") return;
    if (node.right === undefined) refuse("operand_type_mismatch");
    const right = resolve(node.right as ConditionOperand);
    if (node.operator === "equals" || node.operator === "not_equals") {
      if (!sharedType(left, right)) refuse("operand_type_mismatch");
      return;
    }
    if (node.operator === "contains" || node.operator === "not_contains") {
      const validText =
        left.type === "text" || (left.literal !== undefined && literalMatchesType(left.literal, "text"));
      const elementType = collectionElementType(left, right.type);
      if (!validText && (!elementType || !literalMatchesType(right.value, elementType)))
        refuse("operator_unsupported");
      return;
    }
    if (node.operator === "in" || node.operator === "not_in") {
      const elementType = collectionElementType(right, left.type);
      if (!elementType || !literalMatchesType(left.value, elementType)) refuse("operator_unsupported");
      return;
    }
    const type = sharedType(left, right);
    if (
      !type ||
      !["text", "number_integer", "number_exact", "money", "date", "date_time"].includes(type)
    )
      refuse("operator_unsupported");
  };

  const validate = (node: ConditionNode): void => {
    if (node.kind === "all" || node.kind === "any") {
      node.conditions.forEach(validate);
      return;
    }
    if (node.kind === "not") {
      validate(node.condition);
      return;
    }
    validateComparison(node);
  };

  const evaluateComparison = (node: ComparisonNode): boolean => {
    const left = resolve(node.left as ConditionOperand);
    if (node.operator === "is_empty") return left.value === null || left.value === "";
    if (node.operator === "is_not_empty") return left.value !== null && left.value !== "";
    const right = resolve(node.right as ConditionOperand);

    if (node.operator === "equals" || node.operator === "not_equals") {
      const type = sharedType(left, right)!;
      const equal = typedValuesEqual(left.value, right.value, type);
      return node.operator === "equals" ? equal : !equal;
    }
    if (node.operator === "contains" || node.operator === "not_contains") {
      const contains =
        left.value !== null &&
        right.value !== null &&
        (typeof left.value === "string"
          ? left.value.includes(String(right.value))
          : Array.isArray(left.value) && left.value.some((entry) => entry === right.value));
      return node.operator === "contains" ? contains : !contains;
    }
    if (node.operator === "in" || node.operator === "not_in") {
      const included =
        left.value !== null &&
        Array.isArray(right.value) &&
        right.value.some((entry) => entry === left.value);
      return node.operator === "in" ? included : !included;
    }

    if (left.value === null || right.value === null) return false;
    const type = sharedType(left, right)!;
    const comparison = compareTypedValues(left.value, right.value, type);
    if (node.operator === "greater_than") return comparison > 0;
    if (node.operator === "greater_than_or_equal") return comparison >= 0;
    if (node.operator === "less_than") return comparison < 0;
    return comparison <= 0;
  };

  const evaluate = (node: ConditionNode): boolean => {
    if (node.kind === "all") return node.conditions.every(evaluate);
    if (node.kind === "any") return node.conditions.some(evaluate);
    if (node.kind === "not") return !evaluate(node.condition);
    return evaluateComparison(node);
  };

  validate(condition);
  return evaluate(condition);
};
