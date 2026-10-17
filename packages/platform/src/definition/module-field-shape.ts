import { fieldTypeKeys } from "../catalogue/catalogues";
import { builderKeySchema } from "../catalogue/identifiers";
import {
  applicationSourceDocumentSchema,
  type ApplicationSourceDocument,
} from "./application-source-contracts";

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

/** How a builder supplies the settings of a field type the source schema accepts. */
export type OfferedFieldType = Readonly<{ type: string; needsMaxLength: boolean }>;

const probeField = (type: string, settings: Record<string, unknown>) => ({
  id: "fld_probe_candidate", key: "probe_candidate", label: "Probe", required: false, unique: false,
  filterable: false, sortable: false, personal_data: "none", public_display: "refused", type, settings,
});

const moduleIndex = (source: ApplicationSourceDocument, moduleKey: string): number =>
  source.body.modules.findIndex((module) => module.key === moduleKey);

/** True when the schema reports no issue at the probe field itself (other issues are not this field's). */
const schemaAcceptsProbe = (
  source: ApplicationSourceDocument, at: number, type: string, settings: Record<string, unknown>,
): boolean => {
  const probe = structuredClone(source);
  const record = probe.body.modules[at]?.record_types[0];
  if (record === undefined) return false;
  record.fields.push(probeField(type, settings) as unknown as Field);
  const parsed = applicationSourceDocumentSchema.safeParse(probe);
  if (parsed.success) return true;
  const index = record.fields.length - 1;
  const expected = ["body", "modules", at, "record_types", 0, "fields", index];
  return !parsed.error.issues.some((issue) => expected.every((segment, position) => issue.path[position] === segment));
};

/** The field types the source schema accepts, in one inline Module, from a type and a maximum length alone. */
export const offeredFieldTypes = (source: ApplicationSourceDocument, moduleKey: string): readonly OfferedFieldType[] => {
  const at = moduleIndex(source, moduleKey);
  if (at < 0) return [];
  return fieldTypeKeys.flatMap((type): OfferedFieldType[] => {
    if (schemaAcceptsProbe(source, at, type, {})) return [{ type, needsMaxLength: false }];
    if (schemaAcceptsProbe(source, at, type, { max_length: 1 })) return [{ type, needsMaxLength: true }];
    return [];
  });
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

const deriveFieldAlias = (recordKey: string, fieldKey: string, taken: ReadonlySet<string>): string => {
  const base = `fld_${recordKey}_${fieldKey}`.slice(0, 150);
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? base : `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
};

/** Adds a field to, or changes one field of, a record type of an inline Module. */
export type InlineModuleFieldChange = Readonly<{
  moduleKey: string;
  recordAlias: string;
  /** Absent to add a new field. */
  fieldAlias?: string;
  label: string;
  type: string;
  required: boolean;
  maxLength?: number;
}>;

export type InlineModuleFieldChangeResult =
  | Readonly<{ kind: "changed"; source: ApplicationSourceDocument; fieldAlias: string }>
  | Readonly<{ kind: "invalid"; issues: readonly string[] }>;

/**
 * The Application source with one field of one owned inline Module added or changed. A new field
 * carries every authored property explicitly; a changed type replaces the field's settings and
 * removes its default, which belong to the previous type. The result is checked by the source schema.
 */
export const changeInlineModuleField = (
  current: ApplicationSourceDocument,
  change: InlineModuleFieldChange,
): InlineModuleFieldChangeResult => {
  const source = structuredClone(current);
  const module = source.body.modules.find((item) => item.key === change.moduleKey);
  const record = module?.record_types.find((item) => item.id === change.recordAlias);
  if (module === undefined || record === undefined)
    return { kind: "invalid", issues: ["The record type is not in this module any more."] };
  const existing = change.fieldAlias === undefined ? undefined
    : record.fields.find((item) => item.id === change.fieldAlias);
  if (change.fieldAlias !== undefined && existing === undefined)
    return { kind: "invalid", issues: ["The field is not in this record type any more."] };
  const offered = offeredFieldTypes(current, change.moduleKey).find((item) => item.type === change.type);
  const settings = offered?.needsMaxLength === true && change.maxLength !== undefined ? { max_length: change.maxLength } : {};
  let fieldAlias: string;
  if (existing === undefined) {
    const key = deriveFieldKey(change.label, new Set(record.fields.map((item) => item.key)));
    if (key === undefined) return { kind: "invalid", issues: ["The label must start with a letter so a key can be made from it."] };
    fieldAlias = deriveFieldAlias(record.key, key,
      new Set(module.record_types.flatMap((item) => [item.id, ...item.fields.map((field) => field.id)])));
    record.fields.push({
      id: fieldAlias, key, label: change.label, required: change.required, unique: false, filterable: false,
      sortable: false, personal_data: "none", public_display: "refused", type: change.type, settings,
    } as unknown as Field);
    // A new field is readable, and changeable where people set it, through the standard permissions.
    includeFieldInStandardPermissions(module, record, { key, type: change.type as Field["type"] });
  } else {
    fieldAlias = existing.id;
    const destination = existing as Record<string, unknown>;
    destination.label = change.label;
    destination.required = change.required;
    if (existing.type !== change.type) {
      delete destination.default;
      destination.type = change.type;
      destination.settings = settings;
    }
  }
  const parsed = applicationSourceDocumentSchema.safeParse(source);
  if (!parsed.success)
    return { kind: "invalid", issues: parsed.error.issues.map((issue) => `${issue.message} (${issue.path.join(" / ")})`) };
  return { kind: "changed", source: parsed.data, fieldAlias };
};
