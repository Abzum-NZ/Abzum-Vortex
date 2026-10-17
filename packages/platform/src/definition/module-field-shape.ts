import { builderKeySchema } from "../catalogue/identifiers";
import type { ApplicationSourceDocument } from "./application-source-contracts";

type InlineModule = ApplicationSourceDocument["body"]["modules"][number];
type RecordType = InlineModule["record_types"][number];
type Field = RecordType["fields"][number];

/** The standard record actions every new record type supports, with the permission each needs. */
export const standardRecordActions = [
  { action: "create", kind: "create", verb: "Create" },
  { action: "read", kind: "read", verb: "Read" },
  { action: "update", kind: "update", verb: "Update" },
  { action: "soft_delete", kind: "delete", verb: "Delete" },
  { action: "restore", kind: "restore", verb: "Restore" },
  { action: "export", kind: "export", verb: "Export" },
] as const;

/** Field types whose value the platform produces, so no person can change them. */
const producedFieldTypes: ReadonlySet<string> = new Set(["reference_number", "calculation", "total"]);

export const standardPermissionKey = (moduleKey: string, recordKey: string, action: string): string =>
  `${moduleKey}.${recordKey}.${action}`;

/** The standard permission keys of one record type, as its creation declares them. */
export const standardPermissionKeys = (moduleKey: string, recordKey: string): Set<string> =>
  new Set(standardRecordActions.map((entry) => standardPermissionKey(moduleKey, recordKey, entry.action)));

/** Whether a field is changed by people (create and update), not produced by the platform. */
export const changeableByPeople = (field: Pick<Field, "type">): boolean => !producedFieldTypes.has(field.type);

/**
 * Adds a new field to the standard permissions of its record type: every standard permission can
 * read it, and create and update can change it unless the platform produces its value. A
 * permission a builder narrowed by hand (one that is not standard) is left as it is.
 */
export const includeFieldInStandardPermissions = (
  module: InlineModule, record: RecordType, field: Pick<Field, "key" | "type">,
): void => {
  const keys = standardPermissionKeys(module.key, record.key);
  for (const permission of module.permissions) {
    if (!keys.has(permission.key) || permission.field_policy === undefined) continue;
    const policy = permission.field_policy as { readable_fields: string[]; changeable_fields: string[] };
    if (!policy.readable_fields.includes(field.key)) policy.readable_fields.push(field.key);
    if ((permission.action_kind === "create" || permission.action_kind === "update") && changeableByPeople(field) &&
        !policy.changeable_fields.includes(field.key)) policy.changeable_fields.push(field.key);
  }
};

const fieldKeyFromLabel = (label: string): string => {
  const words = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const lettered = /^[a-z]/.test(words) ? words : `field_${words}`.replace(/_+$/, "");
  return lettered.slice(0, 40).replace(/_+$/, "");
};

/** A stable key from the label, unique within its record type; it never changes after the field exists. */
export const deriveFieldKey = (label: string, taken: ReadonlySet<string>): string | undefined => {
  const base = fieldKeyFromLabel(label);
  if (!builderKeySchema.safeParse(base).success) return undefined;
  for (let n = 1; n < 1_000; n += 1) {
    const suffix = n === 1 ? "" : `_${n}`;
    const candidate = `${base.slice(0, 40 - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return undefined;
};

/** A local alias for a new field (or its relationship), unique among the aliases already taken. */
export const deriveFieldAlias = (recordKey: string, fieldKey: string, taken: ReadonlySet<string>): string => {
  const base = `fld_${recordKey}_${fieldKey}`.slice(0, 150);
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? base : `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
};

