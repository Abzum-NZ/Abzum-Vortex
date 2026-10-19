import {
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  readActionList,
  type RecordsTableActionContract,
  type RecordsTableFeatureDefinition,
} from "./shared";

/**
 * Bulk actions: people select several rows and run one named command over the selection, each
 * command bound to a flow that accepts the selected records. Turning it on is what makes rows
 * selectable.
 */
export type RecordsTableBulkActionsSettings = Readonly<{
  actions: readonly RecordsTableActionContract[];
}>;

export const recordsTableBulkActionsFeature: RecordsTableFeatureDefinition<RecordsTableBulkActionsSettings> =
  {
    key: "bulk_actions",
    label: "Bulk actions",
    description: "Select rows and run a command over them",
    read: (group) =>
      featureEnabled(group) === true
        ? { enabled: true, actions: readActionList(group["actions"]) }
        : { enabled: false },
    // A selection of records needs rows that are records: a grouped or summarised query has none.
    check: (state, facts) =>
      !facts.grouped && (!state.enabled || state.actions.length > 0)
        ? featureAvailable
        : featureNotPossible("definition_records_table_bulk_actions"),
  };
