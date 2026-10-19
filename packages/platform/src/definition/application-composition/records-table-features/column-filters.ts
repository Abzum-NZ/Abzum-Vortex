import {
  factsOf,
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  fieldList,
  type RecordsTableFeatureDefinition,
} from "./shared";

/** Column filters: one filter control for each chosen field. */
export type RecordsTableColumnFiltersSettings = Readonly<{ fields: readonly string[] }>;

export const recordsTableColumnFiltersFeature: RecordsTableFeatureDefinition<RecordsTableColumnFiltersSettings> =
  {
    key: "column_filters",
    label: "Column filters",
    description: "Filter the rows by the values of chosen fields",
    read: (group) =>
      featureEnabled(group) === true
        ? { enabled: true, fields: fieldList(group["fields"]) }
        : { enabled: false },
    // Every chosen field must be one the bound query selects and can filter by; a feature that is
    // off needs at least one such field to be possible.
    check: (state, facts) => {
      const filterable = (field: string) => factsOf(facts, field)?.filterable === true;
      const possible = state.enabled
        ? state.fields.length > 0 && state.fields.every(filterable)
        : facts.fields.some((field) => field.filterable);
      return possible
        ? featureAvailable
        : featureNotPossible("definition_records_table_column_filters");
    },
  };
