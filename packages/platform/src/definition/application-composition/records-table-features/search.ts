import {
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  type RecordsTableFeatureDefinition,
} from "./shared";

/** Search: one search box over the fields the record type marks searchable. It has no settings. */
export type RecordsTableSearchSettings = Readonly<Record<never, never>>;

export const recordsTableSearchFeature: RecordsTableFeatureDefinition<RecordsTableSearchSettings> =
  {
    key: "search",
    label: "Search",
    description: "A search box over the searchable fields",
    read: (group) => (featureEnabled(group) === true ? { enabled: true } : { enabled: false }),
    // The Query engine searches only the selected fields the record type marks searchable.
    check: (_state, facts) =>
      facts.fields.some((field) => field.searchable)
        ? featureAvailable
        : featureNotPossible("definition_records_table_search"),
  };
