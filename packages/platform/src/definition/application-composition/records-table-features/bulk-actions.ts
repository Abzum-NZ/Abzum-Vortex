import type { ComponentSettingValue } from "../block-property-schema";
import {
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  settingGroup,
  settingItems,
  settingText,
  type RecordsTableFeatureDefinition,
} from "./shared";

/** The maximum authored action limit; explicit selections also have a 200-record page cap. */
export const recordsTableBulkActionRecordLimit = 5_000;

/**
 * One bulk action: a named action of the bound record type that people run over the selected rows,
 * or over every record the table's query, filters and search match. `action` is the action's key
 * as the release names it; `confirm` asks before it runs, with the exact count; `maxRecords` caps a
 * run over either kind of selection.
 */
export type RecordsTableBulkActionContract = Readonly<{
  action: string;
  label: string;
  confirm: boolean;
  maxRecords: number;
}>;

/**
 * Bulk actions: people select rows on this page, or every matching record, and run one named action
 * over the selection. Turning it on is what makes rows selectable.
 */
export type RecordsTableBulkActionsSettings = Readonly<{
  actions: readonly RecordsTableBulkActionContract[];
}>;

const settingAction = (value: ComponentSettingValue | undefined): string | undefined =>
  value?.kind !== "action_reference"
    ? undefined
    : "actionKey" in value
      ? String(value.actionKey)
      : String(value.action);

/** Reads the declared bulk actions, keeping only entries that name an action and a label. */
const readBulkActions = (
  value: ComponentSettingValue | undefined,
): RecordsTableBulkActionContract[] =>
  (settingItems(value) ?? []).flatMap((item): RecordsTableBulkActionContract[] => {
    const entry = settingGroup(item);
    if (entry === undefined) return [];
    const action = settingAction(entry["action"]);
    const label = settingText(entry["label"]);
    const confirm = entry["confirm"];
    const maxRecords = entry["max_records"];
    if (
      action === undefined ||
      label === undefined ||
      confirm?.kind !== "boolean" ||
      maxRecords?.kind !== "number"
    )
      return [];
    return [{ action, label, confirm: confirm.value, maxRecords: maxRecords.value }];
  });

const sameKey = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

export const recordsTableBulkActionsFeature: RecordsTableFeatureDefinition<RecordsTableBulkActionsSettings> =
  {
    key: "bulk_actions",
    label: "Bulk actions",
    description: "Select rows, or every matching record, and run a named action over them",
    read: (group) =>
      featureEnabled(group) === true
        ? { enabled: true, actions: readBulkActions(group["actions"]) }
        : { enabled: false },
    // A selection of records needs rows that are records (a grouped or summarised query has none)
    // and a named action of their record type that runs on several records, each on its own.
    check: (state, facts) => {
      const offered = facts.actions.filter((action) => action.acceptsSelection);
      const needed = featureNotPossible(
        "definition_records_table_bulk_actions",
        `Bulk actions need a named action of ${facts.recordTypeLabel || "the record type"} that accepts several records`,
      );
      if (facts.grouped || (!state.enabled && offered.length === 0)) return needed;
      if (!state.enabled) return featureAvailable;
      if (state.actions.length === 0) return needed;
      if (state.actions.length > 20)
        return featureNotPossible(
          "definition_records_table_bulk_actions",
          "Choose at most 20 bulk actions",
        );
      if (
        new Set(state.actions.map((action) => action.action.toLowerCase())).size !==
        state.actions.length
      )
        return featureNotPossible(
          "definition_records_table_bulk_actions",
          "Choose each bulk action once",
        );
      for (const declared of state.actions) {
        const action = facts.actions.find((candidate) => sameKey(candidate.key, declared.action));
        if (action === undefined) return needed;
        if (!action.acceptsSelection)
          return featureNotPossible(
            "definition_records_table_bulk_actions",
            `${action.label} changes one record at a time, so it cannot run on a selection`,
          );
        if (
          !Number.isInteger(declared.maxRecords) ||
          declared.maxRecords < 1 ||
          declared.maxRecords > recordsTableBulkActionRecordLimit
        )
          return featureNotPossible(
            "definition_records_table_bulk_actions",
            "Set a limit of at most 5,000 records",
          );
      }
      return featureAvailable;
    },
  };
