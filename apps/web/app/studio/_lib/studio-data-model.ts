import {
  moduleFieldTypeLabels,
  peopleDirectory,
  type ApplicationSourceDocument,
  type ModuleField,
  type ModuleFieldType,
  type ModuleQueryExposure,
  type RecordOwnershipMode,
} from "@vortex/platform/schema";
import type { StudioQueryInput } from "@vortex/ui/studio";
import type { ModuleExtensionPointUse } from "@vortex/platform/schema";
import type { StudioDraft, StudioRunOptions } from "../_components/use-studio-draft";

/**
 * The Data tab's one edit path: `command` changes the current draft source; a result of kind
 * "changed" with a source is one edit of the draft (one Undo step, or one merged step with
 * `merge`), any other result changes nothing and is answered as it is. "blocked" says the draft
 * cannot be edited now (loading, publishing, or changed elsewhere).
 */
export type StudioDataEdit = <Result extends Readonly<{ kind: string }>>(
  command: (source: ApplicationSourceDocument) => Result,
  options?: StudioRunOptions,
) => Result | Readonly<{ kind: "blocked"; message: string }>;

/** The Data tab's one edit path over a draft: a platform command over its current source, as one edit of it. */
export const studioDataEdit =
  (draft: StudioDraft): StudioDataEdit =>
  (command, options) => {
    const outcome = draft.run((current) => {
      const result = command(current);
      const changed =
        result.kind === "changed"
          ? (result as Readonly<{ source?: ApplicationSourceDocument }>).source
          : undefined;
      return changed === undefined
        ? { kind: "keep", result }
        : { kind: "edit", source: changed, result };
    }, options);
    return outcome.kind === "blocked" ? outcome : outcome.result;
  };

/** Why an edit was kept out of the draft, in words; undefined when it was applied. */
export const studioEditProblem = (result: Readonly<{ kind: string }>): string | undefined => {
  if (result.kind === "changed") return undefined;
  const { message, issues, issue } = result as Readonly<{
    message?: string;
    issues?: readonly string[];
    issue?: string;
  }>;
  return message ?? (issues === undefined ? issue : issues.join(" ")) ?? "Nothing was changed.";
};

/**
 * What any published version of the application's own modules held, as qualified
 * references: record types (`module:record`) and fields (`module:record.field`). Their stored shape
 * is fixed. It is read from the stored releases, so a draft that does not compile still has it; an
 * application never published has none.
 */
export type StudioPublishedData = Readonly<{
  recordTypes: readonly string[];
  fields: readonly string[];
  extensionPointUses: readonly ModuleExtensionPointUse[];
}>;

/**
 * The compiled fields of every record type the saved draft binds (`module:record`), with their
 * identities, as the draft compile of one saved revision produced them. A query filter's typed
 * controls work on these; null when the draft did not compile.
 */
export type StudioCompiledFields = Readonly<{
  draftRevision: number;
  recordTypes: Readonly<Record<string, readonly ModuleField[]>>;
}>;

/** One field as the Data tab's schema grid shows it. */
type StudioDataField = Readonly<{
  key: string;
  label: string;
  type: string;
  required: boolean;
  unique: boolean;
  description: string;
  filterable: boolean;
  sortable: boolean;
  /** Its personal data class: special personal data is never indexed for search. */
  personalData: string;
  /** The priority its module indexes it for search with; absent when it is not indexed. */
  searchPriority?: "first" | "normal" | "last";
}>;

/** One record type in the Data tab's tree, from the draft (owned) or the installed module (used). */
export type StudioDataRecordType = Readonly<{
  key: string;
  name: string;
  pluralName: string;
  titleFieldKey: string;
  fields: readonly StudioDataField[];
  /** Ordinary business records can be linked; protected administration projections cannot. */
  linkable: boolean;
  /** Who owns each record; a record type inheriting its owner from a link reads it from there. */
  ownershipMode: RecordOwnershipMode;
}>;

/** One query of a module, by the record type it reads. */
export type StudioDataQuery = Readonly<{
  key: string;
  label: string;
  recordKey: string;
  /** Whether it groups records or adds totals: then it reads as a summary, not as a list. */
  summary: boolean;
  /** Whether the applications that use its module may read it; a used module lists only exposed ones. */
  exposure: ModuleQueryExposure;
  /** The values it asks for. */
  inputs: readonly StudioQueryInput[];
}>;

/** A module in the Data tab: one the application owns (edited here) or one it uses (read-only). */
export type StudioDataModule = Readonly<{
  key: string;
  name: string;
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
  Object.hasOwn(moduleFieldTypeLabels, type)
    ? moduleFieldTypeLabels[type as ModuleFieldType]
    : sentence(type);

/** A query's name: its label, else its key in words. */
const queryLabel = (query: Readonly<{ key: string; label?: string | undefined }>): string =>
  query.label ?? sentence(query.key);

/** The modules the draft owns, as the Data tab shows them. */
export const ownedDataModules = (source: ApplicationSourceDocument): readonly StudioDataModule[] =>
  source.body.modules.map((module) => ({
    key: module.key,
    name: module.name,
    recordTypes: module.record_types.map((record) => ({
      key: record.key,
      name: record.name,
      pluralName: record.plural_name,
      titleFieldKey: record.title_field,
      linkable:
        record.system_projection === undefined ||
        `${module.key}:${record.key}` === peopleDirectory.recordType,
      ownershipMode: record.ownership_mode,
      fields: record.fields.map((field) => ({
        key: field.key,
        label: field.label,
        type: field.type,
        required: field.required,
        unique: field.unique,
        description: field.help_text ?? "",
        filterable: field.filterable,
        sortable: field.sortable,
        personalData: field.personal_data,
        ...(field.search_priority === undefined ? {} : { searchPriority: field.search_priority }),
      })),
    })),
    queries: module.queries.map((query) => ({
      key: query.key,
      label: queryLabel(query),
      summary: query.group_by.length > 0 || query.aggregates.length > 0,
      recordKey: query.record_type.includes(":")
        ? query.record_type.slice(query.record_type.indexOf(":") + 1)
        : query.record_type,
      exposure: query.exposure,
      inputs: query.inputs.map((input) => ({
        key: input.key,
        label: input.label,
        type: input.type,
        required: input.required,
        ...(input.type === "record_reference"
          ? {
              recordTypes: input.record_types.map((type) =>
                type.includes(":") ? type : `${module.key}:${type}`,
              ),
            }
          : {}),
      })),
    })),
  }));
