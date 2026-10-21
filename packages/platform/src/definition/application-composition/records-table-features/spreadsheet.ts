import {
  factsOf,
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  requiredBoolean,
  requiredChoice,
  requiredFieldList,
  requiredItems,
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
  rangeSelect: boolean;
  find: boolean;
  paste: boolean;
  fill: boolean;
  undo: boolean;
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
      !featureEnabled(group)
        ? { enabled: false }
        : {
            enabled: true,
            rangeSelect: requiredBoolean(group["range_select"], "range_select"),
            find: requiredBoolean(group["find"], "find"),
            paste: requiredBoolean(group["paste"], "paste"),
            fill: requiredBoolean(group["fill"], "fill"),
            undo: requiredBoolean(group["undo"], "undo"),
            statusBarFields: requiredFieldList(group["status_bar_fields"], "status_bar_fields"),
            statusBarOperations: requiredItems(
              group["status_bar_operations"],
              "status_bar_operations",
            ).map((item, index) =>
              requiredChoice(
                item,
                recordsTableStatusBarOperations,
                `status_bar_operations[${index}]`,
              ),
            ),
          },
    check: (state, facts) => {
      if (facts.grouped || facts.fields.length === 0) return featureNotPossible(code);
      if (!state.enabled) return featureAvailable;
      if (!state.rangeSelect && !state.find) return featureNotPossible(code);
      if (state.undo && !state.paste && !state.fill)
        return featureNotPossible(code, "Undo needs Paste or Fill");
      if ((state.paste || state.fill) && !state.rangeSelect)
        return featureNotPossible(code, "Paste and fill need Range selection turned on.");
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
        if (!facts.columnFieldIds.some((column) => column.toLowerCase() === field.toLowerCase()))
          return featureNotPossible(
            code,
            "Status bar totals need a field the table shows as a column.",
          );
      }
      return featureAvailable;
    },
  };
