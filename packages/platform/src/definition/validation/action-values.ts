import { valueTypesCompatible } from "../../schema";
import type { JsonObject } from "./context";
import { object, array } from "./helpers";
import {
  fieldRecordTypeIds,
  typedSemanticFieldType,
  typedFieldValueType,
  type ModuleValueDialect,
  fieldValueMatches,
} from "./field-types";

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

const actionValueLiteral = (value: unknown): unknown => {
  const entry = object(value);
  return entry.kind === "literal" ? object(entry.literal).value : undefined;
};

/** A task value map key names a field; source maps key by alias and canonical maps by field id. */
export const actionFieldByKey = (
  fields: ReadonlyMap<string, JsonObject>,
  key: string,
): JsonObject | undefined => {
  const direct = fields.get(key);
  if (direct !== undefined) return direct;
  for (const field of fields.values()) if (String(field.key) === key) return field;
  return undefined;
};

function actionValueRecordTypeIds(
  value: unknown,
  fields: ReadonlyMap<string, JsonObject>,
  inputs: ReadonlyMap<string, JsonObject>,
  subjectRecordTypeId: string,
): string[] | undefined {
  const reference = actionValueReference(value);
  if (reference === undefined) return undefined;
  if (reference.source === "input") {
    const input = inputs.get(String(reference.name));
    if (input === undefined)
      return String(reference.name) === "record" ? [subjectRecordTypeId] : undefined;
    if (input.type !== "record_reference") return undefined;
    const references = array(input.recordTypes ?? input.record_types);
    return references.map((entry) =>
      typeof entry === "string" ? entry : String(entry.recordTypeId),
    );
  }
  if (reference.source === "trigger_record")
    return fieldRecordTypeIds(actionFieldByKey(fields, String(reference.field)));
  return undefined;
}

function actionValueType(
  value: unknown,
  fields: ReadonlyMap<string, JsonObject>,
  inputs: ReadonlyMap<string, JsonObject>,
): string | undefined {
  const reference = actionValueReference(value);
  if (reference === undefined) return undefined;
  if (reference.source === "input") {
    const input = inputs.get(String(reference.name));
    if (input === undefined)
      return String(reference.name) === "record" ? "record_reference" : undefined;
    return input.type === "formatted_text" ? "formatted_text" : typedSemanticFieldType(input.type);
  }
  if (reference.source === "trigger_record") {
    const field = actionFieldByKey(fields, String(reference.field));
    return ["formatted_text", "table", "attachment"].includes(String(field?.type))
      ? String(field!.type)
      : typedFieldValueType(field);
  }
  if (reference.source === "execution_actor") return "organization_account_reference";
  if (reference.source === "execution_now") return "date_time";
  return undefined;
}

export function actionValueCompatible(
  value: unknown,
  targetField: JsonObject | undefined,
  fields: ReadonlyMap<string, JsonObject>,
  inputs: ReadonlyMap<string, JsonObject>,
  subjectRecordTypeId: string,
  dialect: ModuleValueDialect = "canonical",
): boolean {
  const entry = object(value);
  const target = object(targetField?.settings).target;
  // Source publication limits this coercion to the People projection. The compiled pass sees
  // the resolved record-type identity instead of its source key.
  const actorAsLink =
    actionValueReference(value)?.source === "execution_actor" &&
    targetField?.type === "link" &&
    (target === "vortex.system_directory:person" || object(target).state === "resolved");
  const expectedType = ["formatted_text", "table", "attachment"].includes(String(targetField?.type))
    ? String(targetField!.type)
    : typedFieldValueType(targetField);
  const compatible =
    entry.kind === "literal"
      ? fieldValueMatches(actionValueLiteral(value), targetField, dialect)
      : actorAsLink ||
        valueTypesCompatible(actionValueType(value, fields, inputs), expectedType, "exact");
  const expectedRecordTypeIds = fieldRecordTypeIds(targetField);
  if (!compatible || expectedRecordTypeIds === undefined) return compatible;
  if (entry.kind === "literal") return compatible;
  const actualRecordTypeIds = actorAsLink
    ? expectedRecordTypeIds
    : actionValueRecordTypeIds(value, fields, inputs, subjectRecordTypeId);
  return (
    actualRecordTypeIds !== undefined &&
    actualRecordTypeIds.length > 0 &&
    actualRecordTypeIds.every((recordTypeId) => expectedRecordTypeIds.includes(recordTypeId))
  );
}

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

export function applicationActionValueCompatible(
  value: unknown,
  target: ApplicationFieldValuePair | undefined,
  subjectFields: ReadonlyMap<string, JsonObject>,
  subjectModuleBound: boolean,
  inputs: ReadonlyMap<string, JsonObject>,
  subjectRecordTypeId: string,
): boolean {
  if (!target) return false;
  const entry = object(value);
  if (entry.kind === "literal")
    return fieldValueMatches(actionValueLiteral(value), target.field, "canonical");
  const reference = actionValueReference(value);
  if (reference?.source === "trigger_record" && !subjectModuleBound) return false;
  if (
    reference?.source === "input" &&
    (inputs.get(String(reference.name))?.type === "formatted_text" ||
      (inputs.get(String(reference.name))?.type === "whole_number" &&
        ["decimal_number", "money"].includes(applicationFieldType(target) ?? "")))
  )
    return false;
  if (
    !valueTypesCompatible(
      actionValueType(value, subjectFields, inputs),
      applicationFieldType(target),
      "mapping",
    )
  )
    return false;
  return actionValueCompatible(value, target.field, subjectFields, inputs, subjectRecordTypeId);
}

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
