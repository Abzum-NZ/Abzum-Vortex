import type { JsonValue } from "../catalogue/common";
import type { FlowRecordType } from "./flow-orchestrator-types";

/** The values a record step writes, named by field identity. */
type NamedRecordValues = Readonly<{
  submittedValues: Record<string, JsonValue>;
  /** The submitted name of each field, by lower-case field id. */
  submittedNames: ReadonlyMap<string, string>;
  /** The key of every field of the record type, by lower-case field id. */
  fieldKeys: ReadonlyMap<string, string>;
}>;

/**
 * The one way a record step's values are named: by the release's field keys or field identities.
 * Any other name, or a field named twice, is invalid, never dropped.
 */
export const nameRecordValues = (
  recordType: FlowRecordType,
  values: Readonly<Record<string, unknown>>,
): NamedRecordValues | undefined => {
  const submittedValues: Record<string, JsonValue> = {};
  const submittedNames = new Map<string, string>();
  const fieldKeys = new Map<string, string>();
  for (const [name, fieldId] of recordType.fieldIds)
    if (name !== fieldId.toLowerCase()) fieldKeys.set(fieldId.toLowerCase(), name);
  for (const [name, value] of Object.entries(values)) {
    const fieldId = recordType.fieldIds.get(name.toLowerCase());
    if (fieldId === undefined || Object.hasOwn(submittedValues, fieldId)) return undefined;
    submittedValues[fieldId] = value as JsonValue;
    submittedNames.set(fieldId.toLowerCase(), name);
  }
  return { submittedValues, submittedNames, fieldKeys };
};

/** A new record has nothing to clear, so a field left empty is simply not set. */
export const withoutEmptyValues = (
  values: Readonly<Record<string, JsonValue>>,
): Record<string, JsonValue> =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null));

/** Whether the values set a choice option that only a named action may set. */
export const setsActionOwnedOption = (
  recordType: FlowRecordType,
  values: Readonly<Record<string, JsonValue>>,
): boolean =>
  Object.entries(values).some(
    ([fieldId, value]) =>
      typeof value === "string" &&
      recordType.optionActions.get(fieldId.toLowerCase())?.has(value) === true,
  );
