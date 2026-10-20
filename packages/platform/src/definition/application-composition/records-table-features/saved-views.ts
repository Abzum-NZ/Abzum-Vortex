import {
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  type RecordsTableFeatureDefinition,
} from "./shared";

/** Personal and shared views; Access assigns the one platform sharing permission. */
export type RecordsTableSavedViewsSettings = Readonly<Record<never, never>>;

export const recordsTableSavedViewsFeature: RecordsTableFeatureDefinition<RecordsTableSavedViewsSettings> =
  {
    key: "saved_views",
    label: "Saved views",
    description: "Save, reopen and share views of the table",
    read: (group) => {
      if (featureEnabled(group) !== true) return { enabled: false };
      return { enabled: true };
    },
    // A view keeps a sort or a filter: a query with no field to sort or filter by has nothing to save.
    check: (_state, facts) =>
      facts.fields.some((field) => field.sortable || field.filterable)
        ? featureAvailable
        : featureNotPossible("definition_records_table_saved_views"),
  };
