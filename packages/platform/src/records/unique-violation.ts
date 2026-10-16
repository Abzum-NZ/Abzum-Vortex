import { databaseCode } from "../catalogue/runtime-primitives";
import type { recordTypeDefinitionSchema } from "../definition/module-contracts";

/** Postgres' unique-violation state; every unique field's index is named for its field id. */
const uniqueViolation = "23505";
const uniqueIndexName = /^ux_([a-f0-9]{8})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{12})$/;

/**
 * The field whose unique index a write violated, read from the index's name (the provisioner names
 * each unique field's index after the field id). Undefined for any other database failure.
 */
export const violatedUniqueFieldId = (error: unknown): string | undefined => {
  if (databaseCode(error) !== uniqueViolation) return undefined;
  const name = (error as { readonly constraint_name?: unknown }).constraint_name;
  const parts = typeof name === "string" ? uniqueIndexName.exec(name) : null;
  return parts === null ? undefined : parts.slice(1).join("-");
};

/**
 * The located, human-worded refusal for a value another record already holds, worded from the
 * definition's own labels. Undefined when the definition declares no such unique field.
 */
export const uniqueValueRefusal = (
  recordType: ReturnType<typeof recordTypeDefinitionSchema.parse>,
  fieldId: string,
): Readonly<{ code: "invalid_value"; fieldId: string; message: string }> | undefined => {
  const field = recordType.fields.find(
    (candidate) => candidate.fieldId.toLowerCase() === fieldId.toLowerCase(),
  );
  if (field === undefined || !field.unique) return undefined;
  return {
    code: "invalid_value",
    fieldId: field.fieldId,
    message: `${field.label} must be unique: another ${recordType.singularLabel.toLowerCase()} already has this value.`,
  };
};
