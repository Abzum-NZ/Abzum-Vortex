import { isBuilderKey } from "../catalogue/identifier-predicates";

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
export type FlowReadFieldsProjectionEntry = { alias: string; field: string };
export type FlowReadFieldsTypeMap = Record<string, FlowReadFieldsScalarType>;

export const isFlowReadFieldsTypeMap = (value: unknown): value is FlowReadFieldsTypeMap => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
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
