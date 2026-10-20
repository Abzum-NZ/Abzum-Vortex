import {
  queryInputValueType,
  recordsTableEditableFieldTypes,
  recordsTableFieldFilterable,
  type QueryBindingField,
  type QueryBindingPageFacts,
  type RecordsTableFeatureKey,
  type RecordsTableQueryFacts,
  type SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";
import type {
  StudioActionChoice,
  StudioQueryChoice,
  StudioQueryField,
  StudioRelationshipChoice,
} from "../contextual-palette";

/**
 * How Studio edits one grid feature's settings once it is switched on. `settings` draws the feature's
 * declared settings with Studio's one set of typed setting controls (fields are picked from the bound
 * query by business name); a feature with its own editor registers `{ kind: "custom" }` here and the
 * Features panel draws that editor.
 * Every feature of the Records table registry has exactly one entry, so the Features panel never
 * meets a feature it cannot show.
 */
export type StudioGridFeatureEditor =
  | Readonly<{
      kind: "settings";
      /** The bound query's fields the feature's field pickers offer; every field when absent. */
      offers?: (field: StudioQueryField) => boolean;
      /**
       * The feature's action pickers offer only the named actions of the record type the query
       * reads; the feature's check says when a chosen one cannot run as the feature needs.
       */
      boundRecordTypeActions?: true;
    }>
  | Readonly<{ kind: "custom" }>;

export const studioGridFeatureEditors: Readonly<
  Record<RecordsTableFeatureKey, StudioGridFeatureEditor>
> = {
  pinning: { kind: "settings" },
  search: { kind: "settings" },
  // Only fields people can filter by: stored, filterable and of a type a filter fits.
  column_filters: {
    kind: "settings",
    offers: (field) =>
      recordsTableFieldFilterable({
        field: field.reference,
        label: field.label,
        type: field.type,
        sortable: field.sortable,
        filterable: field.filterable,
        searchable: field.searchable,
        editable: false,
        parentLink: false,
      }),
  },
  saved_views: { kind: "settings" },
  bulk_actions: { kind: "settings", boundRecordTypeActions: true },
  inline_edit: { kind: "settings" },
  master_detail: { kind: "settings" },
  // Only the links from a record type to itself can name a record's parent.
  tree: { kind: "settings", offers: (field) => field.parentLink === true },
  conditional_formatting: { kind: "custom" },
  board: { kind: "custom" },
};

/**
 * The settings a feature starts with when it is switched on, so the definition holds them from the
 * start. A feature that is off holds only its switch, so these cannot be catalogue defaults.
 */
export const studioGridFeatureStartSettings: Readonly<
  Partial<
    Record<RecordsTableFeatureKey, Readonly<Record<string, SourceBlockPropertyValueContract>>>
  >
> = {
  // Related records read ten at a time unless the builder chooses otherwise.
  master_detail: { child_page_size: { kind: "number", value: 10 } },
  // A tree reads forty records of a level at a time unless the builder chooses otherwise.
  tree: { child_page_size: { kind: "number", value: 40 } },
};

/**
 * What the draft offers a row's related records: every query and link it can read, the page's
 * binding facts and the fields of the table's record type a This row binding may name.
 */
export type StudioRelatedRecordsChoices = Readonly<{
  queries: readonly StudioQueryChoice[];
  relationships: readonly StudioRelationshipChoice[];
  recordTypeLabel: (recordType: string) => string;
  page: QueryBindingPageFacts;
  rowFields: readonly QueryBindingField[];
}>;

/**
 * The bound query's facts as the draft holds them, in the spelling the table's settings use
 * (qualified field references), so Studio runs the same feature check publication runs on the
 * compiled release. A query that is not chosen yet offers nothing.
 */
export const studioRecordsTableQueryFacts = (
  query: StudioQueryChoice | undefined,
  actions: readonly StudioActionChoice[],
  relationships: readonly StudioRelationshipChoice[],
  related: StudioRelatedRecordsChoices,
): RecordsTableQueryFacts => ({
  recordTypeLabel: query?.label ?? "",
  fields: (query?.fields ?? []).map((field) => ({
    field: field.reference,
    label: field.label,
    type: field.type,
    sortable: field.sortable,
    filterable: field.filterable,
    searchable: field.searchable,
    editable: query?.grouped !== true && recordsTableEditableFieldTypes.includes(field.type),
    parentLink: field.parentLink === true,
    ...(field.choiceCount === undefined ? {} : { choiceCount: field.choiceCount }),
    ...(field.choiceValues === undefined ? {} : { choiceValues: field.choiceValues }),
    ...(field.resultType === undefined ? {} : { resultType: field.resultType }),
  })),
  relationships: relationships
    .filter((relationship) => relationship.recordType === query?.recordType)
    .map((relationship) => ({ key: relationship.reference, label: relationship.label })),
  actions: actions
    .filter((action) => action.recordType === query?.recordType)
    .map((action) => ({
      key: action.reference,
      label: action.label,
      acceptsSelection: action.acceptsSelection,
    })),
  grouped: query?.grouped === true,
  board: query?.board,
  relatedRecords: {
    recordType: query?.recordType ?? "",
    links:
      query === undefined
        ? []
        : related.relationships
            .filter((relationship) => relationship.targets.includes(query.recordType))
            .map((relationship) => ({
              relationship: relationship.reference,
              label: relationship.label,
              childRecordType: relationship.recordType,
              childRecordTypeLabel: related.recordTypeLabel(relationship.recordType),
            })),
    queries: related.queries.map((candidate) => ({
      query: candidate.reference,
      label: candidate.label,
      recordType: candidate.recordType,
      fields: candidate.fields.map((field) => ({ field: field.reference, label: field.label })),
      inputs: candidate.inputs.map((input) => ({
        key: input.key,
        label: input.label,
        required: input.required,
        type: queryInputValueType(input),
      })),
      grouped: candidate.grouped,
    })),
    rowFields: related.rowFields,
    page: related.page,
  },
});
