import type { JsonObject } from "./context";
import { object } from "./helpers";
import { typedFieldValueType } from "./field-types";

/**
 * The reference sources a named-action task value may read. An action value is a flow value
 * (`{ kind: "literal", literal }` or `{ kind: "reference", reference }`); an input reference names
 * a declared action input, a trigger-record reference names a subject field by its key, and the
 * reserved `record` input is the whole subject record the compiler supplies to the action flow.
 */
const actionValueReferenceSources: ReadonlySet<string> = new Set([
  "input",
  "trigger_record",
  "execution_actor",
  "execution_now",
]);

const actionValueReference = (value: unknown): JsonObject | undefined => {
  const entry = object(value);
  return entry.kind === "reference" ? object(entry.reference) : undefined;
};

export type ApplicationFieldValuePair = Readonly<{
  field: JsonObject;
}>;

export const applicationFieldType = (
  pair: ApplicationFieldValuePair | undefined,
): string | undefined => {
  if (!pair) return undefined;
  if (["formatted_text", "table", "attachment"].includes(String(pair.field.type)))
    return String(pair.field.type);
  return typedFieldValueType(pair.field);
};

export const actionValueReferenceEntry = (entry: JsonObject): JsonObject | undefined =>
  actionValueReferenceSources.has(String(entry.source)) ? entry : actionValueReference(entry);

export const applicationInterfaceFieldType = (
  pair: ApplicationFieldValuePair | undefined,
): string | undefined => {
  const type = applicationFieldType(pair);
  if (!pair) return type;
  if (type === "whole_number") return "whole_number";
  if (type === "decimal_number" || type === "money") return type;
  if (type === "yes_no") return "yes_no";
  if (["text", "date", "date_time", "record_reference"].includes(String(type))) return type;
  return undefined;
};
