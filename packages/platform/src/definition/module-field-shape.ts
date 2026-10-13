import { fieldTypeKeys } from "../catalogue/catalogues";
import { builderKeySchema } from "../catalogue/identifiers";
import { moduleSourceDocumentSchema, type ModuleSourceDocument } from "./module-source-contracts";

type RecordType = ModuleSourceDocument["body"]["record_types"][number];
type Field = RecordType["fields"][number];

/** How a builder supplies the settings of a field type the Module schema accepts. */
export type OfferedFieldType = Readonly<{ type: string; needsMaxLength: boolean }>;

const probeField = (type: string, settings: Record<string, unknown>) => ({
  id: "fld_probe_candidate", key: "probe_candidate", label: "Probe", required: false, unique: false,
  filterable: false, sortable: false, personal_data: "none", public_display: "refused", type, settings,
});

/** True when the schema reports no issue at the probe field itself (other issues are not this field's). */
const schemaAcceptsProbe = (source: ModuleSourceDocument, type: string, settings: Record<string, unknown>): boolean => {
  const probe = structuredClone(source);
  const record = probe.body.record_types[0];
  if (record === undefined) return false;
  record.fields.push(probeField(type, settings) as unknown as Field);
  const parsed = moduleSourceDocumentSchema.safeParse(probe);
  if (parsed.success) return true;
  const index = record.fields.length - 1;
  return !parsed.error.issues.some((issue) => issue.path[0] === "body" && issue.path[1] === "record_types" &&
    issue.path[2] === 0 && issue.path[3] === "fields" && issue.path[4] === index);
};

/** The field types the Module source schema accepts from a type and a maximum length alone. */
export const offeredFieldTypes = (source: ModuleSourceDocument): readonly OfferedFieldType[] =>
  fieldTypeKeys.flatMap((type): OfferedFieldType[] => {
    if (schemaAcceptsProbe(source, type, {})) return [{ type, needsMaxLength: false }];
    if (schemaAcceptsProbe(source, type, { max_length: 1 })) return [{ type, needsMaxLength: true }];
    return [];
  });

export const settingsForType = (offered: OfferedFieldType, maxLength: number | undefined): Record<string, unknown> =>
  offered.needsMaxLength && maxLength !== undefined ? { max_length: maxLength } : {};

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

export const deriveFieldAlias = (recordKey: string, fieldKey: string, taken: ReadonlySet<string>): string => {
  const base = `fld_${recordKey}_${fieldKey}`.slice(0, 150);
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? base : `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
};

/** A new field carries every authored property explicitly; nothing is left to a reader's default. */
export const newAuthoredField = (
  alias: string, key: string, label: string, required: boolean, type: string, settings: Record<string, unknown>,
): Field => ({
  id: alias, key, label, required, unique: false, filterable: false, sortable: false,
  personal_data: "none", public_display: "refused", type, settings,
}) as unknown as Field;
