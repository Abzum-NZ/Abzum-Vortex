import {
  exactDecimalTextV2Schema,
  jsonValueSchema,
  moduleFieldValueV2Schemas,
  moneyValueV2Schema,
  organizationAccountIdSchema,
  parseExactDecimal,
  personLinkValueV2Schema,
  recordLinkValueV2Schema,
  type ExactDecimal,
  type FlowFormula,
  type JsonValue,
  type ModuleFieldV3,
} from "@vortex/contracts";
import {
  TypedConditionEvaluationError,
  type TypedConditionEvaluationErrorReason,
} from "./typed-condition-error";
import { evaluateFlowFormula } from "./flow-formula";
import { flowInstantMicros } from "./flow-instant";
import {
  type ResolvedTypedConditionNode,
  type ResolvedTypedConditionOperand,
  validDate,
  validText,
} from "./typed-condition-core";

export type SemanticTypeV2 =
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

export type ResolvedTypedConditionOperandV2 = ResolvedTypedConditionOperand<SemanticTypeV2> &
  Readonly<{ missing?: boolean }>;

const refuse = (reason: TypedConditionEvaluationErrorReason): never => {
  throw new TypedConditionEvaluationError(reason);
};

export const semanticTypeForFieldV2 = (field: ModuleFieldV3): SemanticTypeV2 => {
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

export const valueMatchesSemanticTypeV2 = (value: JsonValue, type: SemanticTypeV2): boolean => {
  if (value === null) return true;
  switch (type) {
    case "text":
      return validText(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "whole_number":
      return typeof value === "number" && Number.isInteger(value);
    case "decimal_number":
      return exactDecimalTextV2Schema.safeParse(value).success;
    case "money":
      return moneyValueV2Schema.safeParse(value).success;
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return validDate(value);
    case "date_time":
      return flowInstantMicros(value) !== undefined;
    case "text_collection":
      return Array.isArray(value) && value.every(validText);
    case "record_reference":
      return recordLinkValueV2Schema.safeParse(value).success;
    case "organization_account_reference":
      return (
        organizationAccountIdSchema.safeParse(value).success ||
        personLinkValueV2Schema.safeParse(value).success
      );
    case "opaque_json":
      return jsonValueSchema.safeParse(value).success;
  }
};

export const valueMatchesFieldV2 = (value: JsonValue, field: ModuleFieldV3): boolean => {
  if (value === null) return true;
  const leafSchema = moduleFieldValueV2Schemas[field.type];
  return (
    leafSchema.safeParse(value).success &&
    valueMatchesSemanticTypeV2(value, semanticTypeForFieldV2(field))
  );
};

const naturalLiteralType = (value: JsonValue): SemanticTypeV2 | undefined => {
  if (value === null) return undefined;
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") {
    if (validDate(value)) return "date";
    if (flowInstantMicros(value) !== undefined) return "date_time";
    return "text";
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
    return "text_collection";
  return "opaque_json";
};

const literalMatchesType = (value: JsonValue, type: SemanticTypeV2): boolean => {
  if (value === null) return true;
  if (type === "decimal_number")
    return (
      exactDecimalTextV2Schema.safeParse(value).success ||
      (typeof value === "number" && Number.isInteger(value))
    );
  return valueMatchesSemanticTypeV2(value, type);
};

const exactFromValue = (value: JsonValue): ExactDecimal | undefined => {
  if (typeof value === "string") {
    if (!exactDecimalTextV2Schema.safeParse(value).success) return undefined;
    return parseExactDecimal(value);
  }
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return parseExactDecimal(BigInt(value).toString());
};

const exactCompatible = (operand: ResolvedTypedConditionOperandV2): boolean => {
  if (operand.value === null) return true;
  if (
    operand.type !== undefined &&
    !["number", "whole_number", "decimal_number"].includes(operand.type)
  )
    return false;
  return exactFromValue(operand.value) !== undefined;
};

const sharedType = (
  left: ResolvedTypedConditionOperandV2,
  right: ResolvedTypedConditionOperandV2,
): SemanticTypeV2 | undefined => {
  if (left.type && right.type) {
    if (left.type === right.type) return left.type;
    if (exactCompatible(left) && exactCompatible(right)) return "decimal_number";
    return undefined;
  }
  if (left.type) {
    if (right.literal !== undefined && literalMatchesType(right.literal, left.type))
      return left.type;
    if (exactCompatible(left) && exactCompatible(right)) return "decimal_number";
    return undefined;
  }
  if (right.type) {
    if (left.literal !== undefined && literalMatchesType(left.literal, right.type))
      return right.type;
    if (exactCompatible(left) && exactCompatible(right)) return "decimal_number";
    return undefined;
  }
  if (left.literal === null && right.literal === null) return "opaque_json";
  if (left.literal === null && right.literal !== undefined)
    return naturalLiteralType(right.literal);
  if (right.literal === null && left.literal !== undefined) return naturalLiteralType(left.literal);
  const leftType = left.literal === undefined ? undefined : naturalLiteralType(left.literal);
  const rightType = right.literal === undefined ? undefined : naturalLiteralType(right.literal);
  return leftType === rightType ? leftType : undefined;
};

const isCollectionElementType = (
  type: SemanticTypeV2 | undefined,
): type is Exclude<SemanticTypeV2, "text_collection" | "opaque_json"> =>
  type !== undefined && type !== "text_collection" && type !== "opaque_json";

const collectionElementType = (
  operand: ResolvedTypedConditionOperandV2,
  expectedType?: SemanticTypeV2,
): SemanticTypeV2 | undefined => {
  if (operand.type === "text_collection") return "text";
  if (!operand.type && Array.isArray(operand.literal)) {
    const values = operand.literal;
    if (values.length === 0)
      return isCollectionElementType(expectedType) ? expectedType : undefined;
    if (
      isCollectionElementType(expectedType) &&
      values.every((value) => literalMatchesType(value, expectedType))
    )
      return expectedType;
    const types = values.map(naturalLiteralType);
    return types.every((type) => type === types[0]) && isCollectionElementType(types[0])
      ? types[0]
      : undefined;
  }
  return undefined;
};

const valueCanBeType = (operand: ResolvedTypedConditionOperandV2, type: SemanticTypeV2): boolean =>
  operand.type
    ? operand.type === type
    : operand.literal !== undefined && literalMatchesType(operand.literal, type);

const recordReferenceIdentity = (value: JsonValue): string | undefined => {
  const parsed = recordLinkValueV2Schema.safeParse(value);
  return parsed.success
    ? `${parsed.data.recordTypeId.toLowerCase()}/${parsed.data.recordId.toLowerCase()}`
    : undefined;
};

const organizationAccountIdentity = (value: JsonValue): string | undefined => {
  const direct = organizationAccountIdSchema.safeParse(value);
  if (direct.success) return direct.data.toLowerCase();
  const linked = personLinkValueV2Schema.safeParse(value);
  return linked.success ? linked.data.organizationAccountId.toLowerCase() : undefined;
};

const moneyParts = (
  value: JsonValue,
): Readonly<{ amount: ExactDecimal; currency: string }> | undefined => {
  const parsed = moneyValueV2Schema.safeParse(value);
  if (!parsed.success) return undefined;
  const amount = exactFromValue(parsed.data.amount);
  return amount === undefined ? undefined : { amount, currency: parsed.data.currency };
};

export const evaluateResolvedTypedConditionV2 = <TSourceOperand>(
  condition: ResolvedTypedConditionNode<TSourceOperand>,
  resolveOperand: (entry: TSourceOperand) => ResolvedTypedConditionOperandV2,
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
    const operator = node.operator;
    const left = resolveOperand(node.left);
    const right = node.right === undefined ? undefined : resolveOperand(node.right);
    if (operator === "is_empty" || operator === "is_not_empty") return;
    const binaryRight = right ?? refuse("input_refused");
    if (left.missing || binaryRight.missing) refuse("input_refused");
    if (operator === "equals" || operator === "not_equals") {
      if (!sharedType(left, binaryRight)) refuse("operator_refused");
      return;
    }
    if (operator === "contains" || operator === "not_contains") {
      const validTextOperands =
        valueCanBeType(left, "text") && valueCanBeType(binaryRight, "text");
      const elementType = collectionElementType(left, binaryRight.type);
      if (!validTextOperands && (!elementType || !valueCanBeType(binaryRight, elementType)))
        refuse("operator_refused");
      return;
    }
    if (operator === "in" || operator === "not_in") {
      const elementType = collectionElementType(binaryRight, left.type);
      if (!elementType || !valueCanBeType(left, elementType)) refuse("operator_refused");
      return;
    }
    const type = sharedType(left, binaryRight);
    if (
      !type ||
      ![
        "text",
        "number",
        "whole_number",
        "decimal_number",
        "money",
        "date",
        "date_time",
      ].includes(type)
    )
      refuse("operator_refused");
    if (type === "money" && left.value !== null && binaryRight.value !== null) {
      const leftMoney = moneyParts(left.value)!;
      const rightMoney = moneyParts(binaryRight.value)!;
      if (leftMoney.currency !== rightMoney.currency) refuse("operator_refused");
    }
  };
  validate(condition);

  const formulaLiteral = (
    operand: ResolvedTypedConditionOperandV2,
    typeOverride?: SemanticTypeV2,
  ): FlowFormula => {
    const sourceType =
      typeOverride ??
      operand.type ??
      (operand.literal === undefined
        ? undefined
        : naturalLiteralType(operand.literal)) ??
      "opaque_json";
    let type: string = sourceType;
    let value = operand.value;
    if (type === "number") {
      type =
        typeof value === "number" && Number.isSafeInteger(value)
          ? "whole_number"
          : "decimal_number";
      if (typeof value === "number") value = String(value);
    } else if (type === "decimal_number" && typeof value === "number") value = String(value);
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
    if (formulas.length === 0)
      return { op: "literal", type: "yes_no", value: op === "and" };
    if (formulas.length === 1) return formulas[0]!;
    if (formulas.length <= 20) return { op, args: [...formulas] };
    const groups: FlowFormula[] = [];
    for (let index = 0; index < formulas.length; index += 20)
      groups.push(combine(op, formulas.slice(index, index + 20)));
    return { op, args: groups };
  };

  const toFormula = (node: ResolvedTypedConditionNode<TSourceOperand>): FlowFormula => {
    if (node.kind === "all" || node.kind === "any")
      return combine(
        node.kind === "all" ? "and" : "or",
        node.conditions.map(toFormula),
      );
    if (node.kind === "not") return { op: "not", arg: toFormula(node.condition) };

    const left = resolveOperand(node.left);
    const leftFormula = formulaLiteral(left);
    if (node.operator === "is_empty" || node.operator === "is_not_empty")
      return { op: node.operator, arg: leftFormula };

    const right = node.right === undefined ? refuse("input_refused") : resolveOperand(node.right);
    const rightFormula = formulaLiteral(right);
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
    if (node.operator === "not_contains")
      return left.value === null || right.value === null
        ? { op: "literal", type: "yes_no", value: true }
        : { op: "not", arg: { op: "contains", left: leftFormula, right: rightFormula } };
    if (node.operator === "contains" && (left.value === null || right.value === null))
      return { op: "literal", type: "yes_no", value: false };
    if (node.operator === "in" || node.operator === "not_in") {
      let membership: FlowFormula;
      if (Array.isArray(right.value)) {
        const elementType = collectionElementType(right, left.type);
        if (elementType === undefined) refuse("operator_refused");
        membership = {
          op: "in",
          value: leftFormula,
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
    refuse("operator_refused");
  return result.value;
};
