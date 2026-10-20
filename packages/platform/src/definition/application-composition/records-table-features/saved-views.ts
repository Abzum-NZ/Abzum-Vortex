import {
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  settingText,
  type RecordsTableFeatureDefinition,
} from "./shared";

/**
 * Saved views: people save and reopen the full state of the table (layout, sort, filters and
 * search) as views that are personal or shared. `sharePermission` is the key of the application
 * permission that lets someone share views and change shared views; without it views stay
 * personal.
 */
export type RecordsTableSavedViewsSettings = Readonly<{ sharePermission?: string }>;

export const recordsTableSavedViewsFeature: RecordsTableFeatureDefinition<RecordsTableSavedViewsSettings> =
  {
    key: "saved_views",
    label: "Saved views",
    description: "Save, reopen and share views of the table",
    read: (group) => {
      if (featureEnabled(group) !== true) return { enabled: false };
      const sharePermission = settingText(group["share_permission"]);
      return { enabled: true, ...(sharePermission === undefined ? {} : { sharePermission }) };
    },
    // A view keeps a sort or a filter: a query with no field to sort or filter by has nothing to save.
    check: (_state, facts) =>
      facts.fields.some((field) => field.sortable || field.filterable)
        ? featureAvailable
        : featureNotPossible("definition_records_table_saved_views"),
  };
