import type { RecordTypeDefinition } from "../definition/module-contracts";
import { sameId } from "../catalogue/runtime-primitives";

/**
 * Whether a value is among the options its field's source offers the saver now. The saver's
 * authority and the source's inputs (the other fields as saved) are the caller's: the writer only
 * asks, so a source that cannot be asked about is refused, never skipped.
 */
export type OptionMembershipCheck = (
  input: Readonly<{
    recordType: RecordTypeDefinition;
    field: RecordTypeDefinition["fields"][number];
    value: unknown;
    /** The saved value of a field of the record type after this save, by field identity. */
    valueOf: (fieldId: string) => unknown;
  }>,
) => Promise<boolean>;

export type OptionSourceRefusal = Readonly<{
  fieldId: string;
  reason: "not_offered" | "unchecked";
}>;

/** The fields whose options a declared query or an options flow works out. */
const sourcedFields = (recordType: RecordTypeDefinition) =>
  recordType.fields.flatMap((field) => {
    if (field.type !== "choice" && field.type !== "link") return [];
    const source = field.settings.optionsSource;
    const inputs =
      source.kind === "flow" || (source.kind === "query" && source.queryId !== undefined)
        ? Object.values(source.inputs ?? {})
        : undefined;
    return inputs === undefined ? [] : [{ field, inputs: inputs.map(String) }];
  });

/**
 * The first field whose saved value is not among the options its source offers, or undefined. Only
 * a field the save touches (its own value or one of the inputs its source reads) is judged, and an
 * empty value needs no option.
 */
export const firstOptionSourceRefusal = async (
  recordType: RecordTypeDefinition,
  submittedFieldIds: readonly string[],
  finalValues: Readonly<Record<string, unknown>>,
  existingValues: Readonly<Record<string, unknown>>,
  check: OptionMembershipCheck | undefined,
): Promise<OptionSourceRefusal | undefined> => {
  const submitted = new Set(submittedFieldIds.map((fieldId) => fieldId.toLowerCase()));
  const valueOf = (fieldId: string): unknown => {
    const key = Object.keys(finalValues).find((candidate) => sameId(candidate, fieldId));
    if (key !== undefined) return finalValues[key];
    const stored = Object.keys(existingValues).find((candidate) => sameId(candidate, fieldId));
    return stored === undefined ? undefined : existingValues[stored];
  };
  for (const { field, inputs } of sourcedFields(recordType)) {
    const fieldId = String(field.fieldId);
    if (![fieldId, ...inputs].some((candidate) => submitted.has(candidate.toLowerCase()))) continue;
    const value = valueOf(fieldId);
    if (value === null || value === undefined) continue;
    if (check === undefined) return { fieldId, reason: "unchecked" };
    if (!(await check({ recordType, field, value, valueOf })))
      return { fieldId, reason: "not_offered" };
  }
  return undefined;
};
