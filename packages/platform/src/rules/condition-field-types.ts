import {
  sourceModuleFieldValueSchemas,
  moduleFieldValueSchemas,
} from "../records/module-field-values";
import { conditionFieldType, typedValueMatchesType } from "./condition-types";

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function fieldValueMatches(
  value: unknown,
  field: Record<string, unknown> | undefined,
  dialect: "source" | "canonical",
): boolean {
  if (!field) return false;
  if (field.type === "calculation" || field.type === "total") {
    const resultType = conditionFieldType(field);
    return resultType !== undefined && typedValueMatchesType(value, resultType, dialect);
  }
  const schemas = dialect === "source" ? sourceModuleFieldValueSchemas : moduleFieldValueSchemas;
  const schema = schemas[String(field.type) as keyof typeof schemas];
  if (schema === undefined || !schema.safeParse(value).success) return false;
  if (
    conditionFieldType(field) === "whole_number" &&
    !typedValueMatchesType(value, "whole_number", dialect)
  )
    return false;
  const expectedRecordTypeIds = fieldRecordTypeIds(field);
  if (expectedRecordTypeIds === undefined) return true;
  const actualRecordTypeId = object(value)[dialect === "source" ? "record_type" : "recordTypeId"];
  return (
    typeof actualRecordTypeId === "string" && expectedRecordTypeIds.includes(actualRecordTypeId)
  );
}

/** @knipignore */
export function fieldRecordTypeIds(
  field: Record<string, unknown> | undefined,
): string[] | undefined {
  if (!field) return undefined;
  const settings = object(field.settings);
  if (field.type === "link")
    return [
      typeof settings.target === "string"
        ? settings.target
        : String(object(settings.target).recordTypeId),
    ];
  if (field.type === "link_to_one_of_several")
    return (Array.isArray(settings.targets) ? settings.targets : []).map((target: unknown) =>
      typeof target === "string" ? target : String(object(target).recordTypeId),
    );
  return undefined;
}
