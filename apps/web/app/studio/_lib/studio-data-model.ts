import { moduleFieldTypeLabels, type ApplicationSourceDocument, type ModuleFieldType } from "@vortex/platform/schema";

/**
 * What the current published versions of the application's own modules hold, as qualified
 * references: record types (`module:record`) and fields (`module:record.field`). Their stored shape
 * is fixed; null when the draft could not be compiled, and then every saved one counts as published.
 */
export type StudioPublishedData = Readonly<{ recordTypes: readonly string[]; fields: readonly string[] }>;

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

const sentence = (key: string): string => {
  const words = key.replaceAll("_", " ");
  return words.length === 0 ? key : words[0]!.toUpperCase() + words.slice(1);
};

/** A field type as a person reads it, from the one field type catalogue; an unknown type is named by its key. */
export const fieldTypeLabel = (type: string): string =>
  Object.hasOwn(moduleFieldTypeLabels, type) ? moduleFieldTypeLabels[type as ModuleFieldType] : sentence(type);

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
