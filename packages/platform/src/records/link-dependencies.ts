import "server-only";

import { sameId, type RecordTypeDefinition } from "../schema";
import type { RequestDatabaseTransaction } from "../db/index";

/**
 * The write-time rule behind a declared field dependency, the same for a record save, a named
 * action and a grid edit. A link field that depends on another link field of its record type
 * (Region on Country) may hold only a record whose declared filter link points at the record the
 * parent holds. A choice field that depends on another choice field may hold only an option that
 * lists the parent's chosen option among its parent values. It is derived from the field
 * declaration alone, runs in the saving transaction under the saver's own access, and does not
 * trust what the form offered.
 */
export type FieldDependencyRefusal = Readonly<{
  childFieldId: string;
  parentFieldId: string;
  /** Why the pair was refused, for the log; the person is told only which field to choose again. */
  reason: "parent_empty" | "child_unreadable" | "child_mismatch";
}>;

type LinkValue = Readonly<{ recordTypeId: string; recordId: string }>;

const linkValue = (value: unknown): LinkValue | undefined =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as Record<string, unknown>).recordTypeId === "string" &&
  typeof (value as Record<string, unknown>).recordId === "string"
    ? {
        recordTypeId: (value as Record<string, string>).recordTypeId!,
        recordId: (value as Record<string, string>).recordId!,
      }
    : undefined;

/**
 * The first dependent link field of the saved record whose value is not consistent with its
 * parent, or undefined when all are. Only a pair the save touches is judged: an update that
 * submits neither the child nor its parent leaves the stored pair as it is.
 */
export const firstFieldDependencyRefusal = async (
  transaction: RequestDatabaseTransaction,
  recordType: RecordTypeDefinition,
  existingValues: Readonly<Record<string, unknown>>,
  submittedFieldIds: readonly string[],
  finalValues: Readonly<Record<string, unknown>>,
): Promise<FieldDependencyRefusal | undefined> => {
  const submitted = new Set(submittedFieldIds.map((fieldId) => fieldId.toLowerCase()));
  const effective = (fieldId: string): unknown => {
    const key = Object.keys(finalValues).find((candidate) => sameId(candidate, fieldId));
    if (key !== undefined) return finalValues[key];
    const stored = Object.keys(existingValues).find((candidate) => sameId(candidate, fieldId));
    return stored === undefined ? undefined : existingValues[stored];
  };
  for (const field of recordType.fields) {
    if (
      (field.type !== "link" && field.type !== "choice") ||
      field.settings.dependsOn === undefined
    )
      continue;
    const childFieldId = String(field.fieldId);
    const { parentFieldId } = field.settings.dependsOn;
    if (
      !submitted.has(childFieldId.toLowerCase()) &&
      !submitted.has(String(parentFieldId).toLowerCase())
    )
      continue;
    const refusal = (reason: FieldDependencyRefusal["reason"]): FieldDependencyRefusal => ({
      childFieldId,
      parentFieldId: String(parentFieldId),
      reason,
    });
    if (field.type === "choice") {
      const chosen = effective(childFieldId);
      if (typeof chosen !== "string") continue;
      const parentChosen = effective(String(parentFieldId));
      if (typeof parentChosen !== "string") return refusal("parent_empty");
      const option = field.settings.options.find((candidate) => candidate.value === chosen);
      if (option?.parentValues?.includes(parentChosen) !== true) return refusal("child_mismatch");
      continue;
    }
    const child = linkValue(effective(childFieldId));
    if (child === undefined) continue;
    const { filterFieldId } = field.settings.dependsOn;
    const parent = linkValue(effective(String(parentFieldId)));
    if (parent === undefined) return refusal("parent_empty");
    // The child is read as the saver reads it: the request role, then back to the save's role.
    await transaction.query`set local role vortex_request`;
    let rows: readonly { record: unknown }[];
    try {
      rows = await transaction.query<{ record: unknown }>`
        select vortex_record.read_record(${child.recordTypeId}::uuid, ${child.recordId}::uuid) as record
      `;
    } finally {
      await transaction.query`set local role vortex_runtime`;
    }
    const read = rows[0]?.record;
    const values =
      typeof read === "object" &&
      read !== null &&
      (read as Record<string, unknown>).outcome === "allowed" &&
      typeof (read as Record<string, unknown>).values === "object" &&
      (read as Record<string, unknown>).values !== null
        ? ((read as Record<string, unknown>).values as Record<string, unknown>)
        : undefined;
    const filterKey =
      values === undefined
        ? undefined
        : Object.keys(values).find((candidate) => sameId(candidate, String(filterFieldId)));
    if (values === undefined || filterKey === undefined) return refusal("child_unreadable");
    const linked = linkValue(values[filterKey]);
    if (linked === undefined || !sameId(linked.recordId, parent.recordId))
      return refusal("child_mismatch");
  }
  return undefined;
};
