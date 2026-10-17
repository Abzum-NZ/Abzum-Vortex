import type {
  ConditionNode, InlineQueryFilter, InlineQueryInput, JsonValue, ModuleField,
} from "@vortex/platform/schema";
import type {
  StudioConditionControlsContext, StudioConditionOperator, StudioConditionParameterType,
} from "@vortex/ui/studio";

type Comparison = Extract<ConditionNode, { kind: "comparison" }>;
type Operand = Comparison["left"];
type FieldOperand = Extract<Operand, { source: "field" }>;
type Plain = Readonly<Record<string, unknown>>;

const object = (value: unknown): value is Plain => value !== null && typeof value === "object" && !Array.isArray(value);
const unary = (operator: unknown): boolean => operator === "is_empty" || operator === "is_not_empty";

/** The query input types a filter can compare a field with, as the typed condition controls name them. */
const parameterTypes: Readonly<Record<string, StudioConditionParameterType>> = {
  text: "text", number: "number", decimal_number: "decimal_number", money: "money", boolean: "boolean",
  date: "date", date_time: "date_time", record_reference: "record_reference",
  organization_account_reference: "organization_account_reference",
};

/** A query's filter as the typed condition controls read it, or why they can't. */
export type StudioQueryFilterReading =
  | Readonly<{ kind: "read"; condition: ConditionNode | undefined }>
  | Readonly<{ kind: "unreadable"; reason: string }>;

/**
 * Reads an authored query filter (by field keys and input keys) as the shared condition tree (by
 * field identities). It is unreadable when it names a field the compiled draft does not know.
 */
export const readStudioQueryFilter = (filter: InlineQueryFilter | null, fieldIdOf: (key: string) => string | undefined): StudioQueryFilterReading => {
  if (filter === null) return { kind: "read", condition: undefined };
  let missing: string | undefined;
  const operand = (value: unknown): Operand | undefined => {
    if (!object(value)) return undefined;
    if (value.source === "field" && typeof value.field === "string") {
      const fieldId = fieldIdOf(value.field);
      if (fieldId === undefined) { missing ??= value.field; return undefined; }
      return { source: "field", fieldId: fieldId as FieldOperand["fieldId"] };
    }
    if (value.source === "value" && "value" in value) return { source: "value", value: value.value as JsonValue };
    if (value.source === "parameter" && typeof value.parameter === "string") return { source: "parameter", key: value.parameter };
    return undefined;
  };
  const read = (value: unknown): ConditionNode | undefined => {
    if (!object(value)) return undefined;
    if (Array.isArray(value.all) || Array.isArray(value.any)) {
      const children = ((value.all ?? value.any) as unknown[]).map(read);
      if (children.some((child) => child === undefined)) return undefined;
      return { kind: Array.isArray(value.all) ? "all" : "any", conditions: children as ConditionNode[] };
    }
    if ("not" in value) {
      const child = read(value.not);
      return child === undefined ? undefined : { kind: "not", condition: child };
    }
    const operator = value.operator as StudioConditionOperator;
    const left = typeof value.field === "string" ? operand({ source: "field", field: value.field }) : operand(value.left);
    if (left === undefined) return undefined;
    if (unary(operator)) return { kind: "comparison", operator, left };
    const right = typeof value.field === "string"
      ? "parameter" in value ? operand({ source: "parameter", parameter: value.parameter }) : operand({ source: "value", value: value.value })
      : operand(value.right);
    return right === undefined ? undefined : { kind: "comparison", operator, left, right };
  };
  const condition = read(filter);
  if (condition !== undefined) return { kind: "read", condition };
  return { kind: "unreadable", reason: missing === undefined
    ? "It is written in a form the filter controls do not edit."
    : `It uses the field "${missing}", which is not in the saved draft. Save the draft to filter by a new field.` };
};

/**
 * Writes the shared condition tree back as an authored query filter, by field and input keys. A
 * field compared with a value or an input takes the short authored form.
 */
export const writeStudioQueryFilter = (condition: ConditionNode | undefined, fieldKeyOf: (fieldId: string) => string | undefined): InlineQueryFilter | null | undefined => {
  if (condition === undefined) return null;
  const operand = (value: Operand): Plain | undefined => {
    if (value.source === "field") {
      const field = fieldKeyOf(value.fieldId);
      return field === undefined ? undefined : { source: "field", field };
    }
    return value.source === "value" ? { source: "value", value: value.value } : { source: "parameter", parameter: value.key };
  };
  const write = (node: ConditionNode): Plain | undefined => {
    if (node.kind === "comparison") return writeComparison(node);
    if (node.kind === "not") {
      const child = write(node.condition);
      return child === undefined ? undefined : { not: child };
    }
    const children = node.conditions.map(write);
    return children.some((child) => child === undefined) ? undefined : { [node.kind]: children };
  };
  const writeComparison = (node: Comparison): Plain | undefined => {
    const left = operand(node.left);
    if (left === undefined) return undefined;
    if (node.left.source === "field") {
      if (node.right === undefined) return { field: left.field, operator: node.operator };
      if (node.right.source === "value") return { field: left.field, operator: node.operator, value: node.right.value };
      if (node.right.source === "parameter") return { field: left.field, operator: node.operator, parameter: node.right.key };
    }
    const right = node.right === undefined ? undefined : operand(node.right);
    if (node.right !== undefined && right === undefined) return undefined;
    return right === undefined ? { operator: node.operator, left } : { operator: node.operator, left, right };
  };
  return write(condition) as InlineQueryFilter | undefined;
};

/**
 * What a query filter may compare: the record type's filterable fields, and the query's inputs
 * whose type a condition can compare. Typed fixed values are allowed.
 */
export const studioQueryFilterContext = (fields: readonly ModuleField[], filterable: ReadonlySet<string>,
  inputs: readonly InlineQueryInput[]): StudioConditionControlsContext => {
  const shown = fields.filter((field) => filterable.has(field.key));
  const parameters = inputs.flatMap((input) => {
    const type = parameterTypes[input.type];
    return type === undefined ? [] : [{ key: input.key, type, label: input.label }];
  });
  return {
    allowedOperands: [
      ...shown.map((field) => ({ operand: { source: "field" as const, fieldId: field.fieldId }, field, label: field.label, role: "current_field" as const })),
      ...parameters.map((parameter) => ({ operand: { source: "parameter" as const, key: parameter.key },
        label: `Input: ${parameter.label}`, role: "declared_input" as const })),
    ],
    declaredFieldIds: shown.map((field) => String(field.fieldId)),
    parameterDeclarations: parameters.map(({ key, type }) => ({ key, type })),
    allowLiteralValues: true,
  };
};
