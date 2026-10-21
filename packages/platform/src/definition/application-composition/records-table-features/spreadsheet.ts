import {
  factsOf,
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  fieldList,
  settingItems,
  type RecordsTableFeatureDefinition,
} from "./shared";

/** What the status bar can total of a selected range, in the order the bar shows it. */
export const recordsTableStatusBarOperations = [
  "count",
  "sum",
  "average",
  "minimum",
  "maximum",
] as const;
export type RecordsTableStatusBarOperation = (typeof recordsTableStatusBarOperations)[number];

/** The most fields one status bar totals. */
export const RECORDS_TABLE_STATUS_BAR_MAXIMUM_FIELDS = 20;

/** The field types a status bar totals: stored numbers, money and dates. */
export const recordsTableStatusBarFieldTypes: readonly string[] = Object.freeze([
  "whole_number",
  "decimal_number",
  "money",
  "date",
  "date_time",
]);

/**
 * Local interactions over the permitted, bounded page. `statusBarFields` and `statusBarOperations`
 * turn on the status bar: the totals of a selected range over those fields, computed on the server
 * for the selected rows of the shown page only. Both are empty while the status bar is off.
 */
export type RecordsTableSpreadsheetSettings = Readonly<{
  rangeSelect?: boolean;
  find?: boolean;
  statusBarFields: readonly string[];
  statusBarOperations: readonly RecordsTableStatusBarOperation[];
}>;

const code = "definition_records_table_spreadsheet" as const;

export const recordsTableSpreadsheetFeature: RecordsTableFeatureDefinition<RecordsTableSpreadsheetSettings> =
  {
    key: "spreadsheet",
    label: "Spreadsheet controls",
    description: "Select a range, find values and total a range within the loaded page",
    read: (group) =>
      featureEnabled(group) !== true
        ? { enabled: false }
        : {
            enabled: true,
            ...(group["range_select"]?.kind === "boolean"
              ? { rangeSelect: group["range_select"].value }
              : {}),
            ...(group["find"]?.kind === "boolean" ? { find: group["find"].value } : {}),
            statusBarFields: fieldList(group["status_bar_fields"]),
            statusBarOperations: (settingItems(group["status_bar_operations"]) ?? []).flatMap(
              (item) =>
                item.kind === "choice" &&
                (recordsTableStatusBarOperations as readonly string[]).includes(item.value)
                  ? [item.value as RecordsTableStatusBarOperation]
                  : [],
            ),
          },
    check: (state, facts) => {
      if (facts.grouped || facts.fields.length === 0) return featureNotPossible(code);
      if (!state.enabled) return featureAvailable;
      if (
        typeof state.rangeSelect !== "boolean" ||
        typeof state.find !== "boolean" ||
        (state.rangeSelect !== true && state.find !== true)
      )
        return featureNotPossible(code);
      const { statusBarFields: fields, statusBarOperations: operations } = state;
      if (fields.length === 0 && operations.length === 0) return featureAvailable;
      if (!state.rangeSelect)
        return featureNotPossible(code, "Status bar totals need Range selection turned on.");
      if (fields.length === 0 || operations.length === 0)
        return featureNotPossible(
          code,
          "Choose both the fields and the totals the status bar shows, or clear both.",
        );
      if (
        fields.length > RECORDS_TABLE_STATUS_BAR_MAXIMUM_FIELDS ||
        new Set(fields.map((field) => field.toLowerCase())).size !== fields.length ||
        new Set(operations).size !== operations.length
      )
        return featureNotPossible(
          code,
          `Choose each status bar field and total once, at most ${RECORDS_TABLE_STATUS_BAR_MAXIMUM_FIELDS} fields.`,
        );
      for (const field of fields) {
        const held = factsOf(facts, field);
        if (held === undefined || !recordsTableStatusBarFieldTypes.includes(held.type))
          return featureNotPossible(
            code,
            "Status bar totals need a number, money or date field the query reads",
          );
      }
      return featureAvailable;
    },
  };
