import {
  queryInputValueType,
  recordsTableFeatureOfEvent,
  type BlockPropertySchemaContract,
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
        parentLink: false,
      }),
  },
  saved_views: { kind: "custom" },
  bulk_actions: { kind: "settings", boundRecordTypeActions: true },
  inline_edit: { kind: "custom" },
  row_edit: { kind: "custom" },
  master_detail: { kind: "settings" },
  // Only the links from a record type to itself can name a record's parent.
  tree: { kind: "settings", offers: (field) => field.parentLink === true },
  // Only choice (and stage) fields people can filter by can be grouped; the check names the rest.
  grouping: { kind: "settings", offers: (field) => field.type === "choice" && field.filterable },
  conditional_formatting: { kind: "custom" },
  // The catalogue restricts the row and column pickers to choice, link and date fields and the measure
  // picker to number and money fields, so Studio offers only fields a pivot can use.
  pivot: { kind: "settings" },
  board: { kind: "custom" },
  export: { kind: "custom" },
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
  row_edit: { trigger: { kind: "choice", value: "button" }, fields: { kind: "list", items: [] } },
  spreadsheet: {
    range_select: { kind: "boolean", value: true },
    find: { kind: "boolean", value: true },
  },
  // Related records read ten at a time unless the builder chooses otherwise.
  master_detail: { child_page_size: { kind: "number", value: 10 } },
  // A tree reads forty records of a level at a time unless the builder chooses otherwise.
  tree: { child_page_size: { kind: "number", value: 40 } },
  // Records with no value are named "Unassigned" unless the builder chooses otherwise.
  grouping: { unassigned_label: { kind: "text", value: "Unassigned" } },
  // Export starts as CSV with the authored default row limit.
  export: {
    formats: { kind: "list", items: [{ kind: "choice", value: "csv" }] },
    max_rows: { kind: "number", value: 10000 },
  },
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
  maximumPageSize: query?.pageSize,
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
  exportable: query?.exportable === true,
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

/** Restore enabled grid features from their one authored workflow binding. */
export const restoreStudioGridFeatureBindings = (
  settings: Record<string, SourceBlockPropertyValueContract>,
  declarations: readonly BlockPropertySchemaContract[],
  bindings: readonly Readonly<{ control: string; event: string; event_id: string }>[],
  alias: string,
): void => {
  // Disabled features contain only their defaults, while their workflows remain authored in the
  // draft. Restore the event from the existing binding when a feature is enabled again.
  const features = settings.features;
  const featureDeclarations = declarations.find((property) => property.key === "features");
  if (features?.kind === "group" && featureDeclarations?.kind === "group") {
    const properties = { ...features.properties };
    for (const binding of bindings) {
      if (binding.control !== alias) continue;
      const key = recordsTableFeatureOfEvent(binding.event);
      if (key === undefined) continue;
      const feature = features.properties[key];
      const declaration = featureDeclarations.properties.find((property) => property.key === key);
      if (
        feature?.kind !== "group" ||
        feature.properties.enabled?.kind !== "boolean" ||
        !feature.properties.enabled.value ||
        declaration?.kind !== "group" ||
        !declaration.properties.some((property) => property.key === "event_id")
      )
        continue;
      properties[key] = {
        ...feature,
        properties: {
          ...feature.properties,
          event_id: { kind: "text", value: binding.event_id },
        },
      };
    }
    settings.features = { ...features, properties };
  }
};
