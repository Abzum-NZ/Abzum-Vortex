import { fieldTypeKeys } from "../catalogue/catalogues";
import { builderKeySchema } from "../catalogue/identifiers";
import {
  applicationSourceDocumentSchema,
  type ApplicationSourceDocument,
} from "./application-source-contracts";

type InlineModule = ApplicationSourceDocument["body"]["modules"][number];
type RecordType = InlineModule["record_types"][number];
type Field = RecordType["fields"][number];

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
