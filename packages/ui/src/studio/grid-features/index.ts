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
  spreadsheet: { kind: "custom" },
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
      }),
  },
  saved_views: { kind: "custom" },
  bulk_actions: { kind: "settings", boundRecordTypeActions: true },
  inline_edit: { kind: "custom" },
  master_detail: { kind: "settings" },
  conditional_formatting: { kind: "custom" },
  // The catalogue restricts the row and column pickers to choice, link and date fields and the measure
  // picker to number and money fields, so Studio offers only fields a pivot can use.
  pivot: { kind: "settings" },
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
  spreadsheet: {
    range_select: { kind: "boolean", value: true },
    find: { kind: "boolean", value: true },
  },
  // Related records read ten at a time unless the builder chooses otherwise.
  master_detail: { child_page_size: { kind: "number", value: 10 } },
  // A pivot starts as a count of records, 40 rows at a time, with totals.
  pivot: {
    measure_function: { kind: "choice", value: "count" },
    row_page_size: { kind: "number", value: 40 },
    totals: { kind: "boolean", value: true },
  },
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
  signedIn: boolean,
  actions: readonly StudioActionChoice[],
  relationships: readonly StudioRelationshipChoice[],
  related: StudioRelatedRecordsChoices,
): RecordsTableQueryFacts => ({
  signedIn,
  recordTypeLabel: query?.label ?? "",
  fields: (query?.fields ?? []).map((field) => ({
    field: field.reference,
    label: field.label,
    type: field.type,
    sortable: field.sortable,
    filterable: field.filterable,
    searchable: field.searchable,
    editable: query?.grouped !== true && recordsTableEditableFieldTypes.includes(field.type),
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
