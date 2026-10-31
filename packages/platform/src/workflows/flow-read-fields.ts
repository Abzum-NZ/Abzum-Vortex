import { isBuilderKey } from "../catalogue/identifier-predicates";
import { isPlainRecord } from "../catalogue/json-value";

/** The maximum number of selected-record output members. */
export const flowMaximumRecordReadFields = 20;

export const flowReadFieldsScalarTypeKeys = [
  "text",
  "formatted_text",
  "whole_number",
  "decimal_number",
  "money",
  "yes_no",
  "date",
  "date_time",
  "choice",
] as const;

export type FlowReadFieldsScalarType = (typeof flowReadFieldsScalarTypeKeys)[number];

const isFlowReadFieldsScalarType = (value: string): value is FlowReadFieldsScalarType =>
  (flowReadFieldsScalarTypeKeys as readonly string[]).includes(value);

/** Maps canonical Module field discriminators to the scalar types a Flow may expose. */
export const flowReadFieldsScalarTypeForField = (
  fieldType: string,
): FlowReadFieldsScalarType | undefined => {
  // A formatted-text value is a structured document, while the Flow scalar evaluator accepts a
  // string: it cannot be projected as-is. Money is projected as its amount (see the reader).
  if (fieldType !== "formatted_text" && isFlowReadFieldsScalarType(fieldType)) return fieldType;
  switch (fieldType) {
    case "long_text":
    case "reference_number":
    case "email_address":
    case "phone_number":
    case "web_address":
      return "text";
    default:
      return undefined;
  }
};
type FlowReadFieldsProjectionEntry = { alias: string; field: string };
type FlowReadFieldsTypeMap = Record<string, FlowReadFieldsScalarType>;

export const isFlowReadFieldsTypeMap = (value: unknown): value is FlowReadFieldsTypeMap => {
  if (!isPlainRecord(value)) return false;
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" && Object.prototype.propertyIsEnumerable.call(value, key),
    )
  )
    return false;
  const entries = Object.entries(value);
  return (
    entries.length >= 1 &&
    entries.length <= flowMaximumRecordReadFields &&
    entries.every(
      ([key, type]) =>
        isBuilderKey(key) &&
        typeof type === "string" &&
        (flowReadFieldsScalarTypeKeys as readonly string[]).includes(type),
    )
  );
};

export const isFlowReadFieldsProjection = (
  value: unknown,
): value is FlowReadFieldsProjectionEntry[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > flowMaximumRecordReadFields)
    return false;
  const aliases = new Set<string>();
  const references = new Set<string>();
  for (const entry of value as unknown[]) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    if (
      Object.keys(item).length !== 2 ||
      !isBuilderKey(item.alias) ||
      typeof item.field !== "string" ||
      item.field.length < 1 ||
      item.field.length > 281 ||
      aliases.has(item.alias) ||
      references.has(item.field)
    )
      return false;
    aliases.add(item.alias);
    references.add(item.field);
  }
  return true;
};
