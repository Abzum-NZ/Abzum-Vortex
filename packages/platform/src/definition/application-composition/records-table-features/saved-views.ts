import {
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  type RecordsTableFeatureDefinition,
} from "./shared";

/** Saved views: people save and reopen their sort and filter combinations. It has no settings. */
export type RecordsTableSavedViewsSettings = Readonly<Record<never, never>>;

export const recordsTableSavedViewsFeature: RecordsTableFeatureDefinition<RecordsTableSavedViewsSettings> =
  {
    key: "saved_views",
    label: "Saved views",
    description: "Save and reopen sort and filter combinations",
    read: (group) => (featureEnabled(group) === true ? { enabled: true } : { enabled: false }),
    // A view keeps a sort or a filter: a query with no field to sort or filter by has nothing to save.
    check: (_state, facts) =>
      facts.fields.some((field) => field.sortable || field.filterable)
        ? featureAvailable
        : featureNotPossible("definition_records_table_saved_views"),
  };
