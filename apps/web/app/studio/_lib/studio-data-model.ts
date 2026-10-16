import type { ApplicationSourceDocument } from "@vortex/platform/schema";

/** One field as the Data tab's schema grid shows it. */
export type StudioDataField = Readonly<{
  key: string; label: string; type: string; required: boolean; unique: boolean; description: string;
}>;

/** One record type in the Data tab's tree, from the draft (owned) or the installed module (used). */
export type StudioDataRecordType = Readonly<{
  key: string; name: string; pluralName: string; titleFieldKey: string; fields: readonly StudioDataField[];
}>;

/** One query of a module, by the record type it reads. */
export type StudioDataQuery = Readonly<{ key: string; label: string; recordKey: string }>;

/** A module in the Data tab: one the application owns (edited here) or one it uses (read-only). */
export type StudioDataModule = Readonly<{
  key: string; name: string;
  /** The key of the application that owns a used module; absent for a module this application owns. */
  ownerApplication?: string;
  recordTypes: readonly StudioDataRecordType[];
  queries: readonly StudioDataQuery[];
}>;

/** What the Data tab has selected: a module, a record type, one of its fields, or a query. */
export type StudioDataSelection =
  | Readonly<{ kind: "module"; moduleKey: string }>
  | Readonly<{ kind: "record_type"; moduleKey: string; recordKey: string }>
  | Readonly<{ kind: "field"; moduleKey: string; recordKey: string; fieldKey: string }>
  | Readonly<{ kind: "query"; moduleKey: string; queryKey: string }>;

const sentence = (key: string): string => {
  const words = key.replaceAll("_", " ");
  return words.length === 0 ? key : words[0]!.toUpperCase() + words.slice(1);
};

/** A field type as a person reads it: "reference_number" becomes "Reference number". */
export const fieldTypeLabel = sentence;

/** A query's name: its label, else its key in words. */
export const queryLabel = (query: Readonly<{ key: string; label?: string | undefined }>): string =>
  query.label ?? sentence(query.key);

/** The modules the draft owns, as the Data tab shows them. */
export const ownedDataModules = (source: ApplicationSourceDocument): readonly StudioDataModule[] =>
  source.body.modules.map((module) => ({
    key: module.key,
    name: module.name,
    recordTypes: module.record_types.map((record) => ({
      key: record.key, name: record.name, pluralName: record.plural_name, titleFieldKey: record.title_field,
      fields: record.fields.map((field) => ({
        key: field.key, label: field.label, type: field.type, required: field.required, unique: field.unique,
        description: field.help_text ?? "",
      })),
    })),
    queries: module.queries.map((query) => ({
      key: query.key, label: queryLabel(query),
      recordKey: query.record_type.includes(":") ? query.record_type.slice(query.record_type.indexOf(":") + 1) : query.record_type,
    })),
  }));
