import {
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  type RecordsTableFeatureDefinition,
} from "./shared";

/** Local interactions over the permitted, bounded page; neither setting reads records. */
export type RecordsTableSpreadsheetSettings = Readonly<{
  rangeSelect?: boolean;
  find?: boolean;
}>;

export const recordsTableSpreadsheetFeature: RecordsTableFeatureDefinition<RecordsTableSpreadsheetSettings> =
  {
    key: "spreadsheet",
    label: "Spreadsheet controls",
    description: "Select a range and find values within the loaded page",
    read: (group) =>
      featureEnabled(group) !== true
        ? { enabled: false }
        : {
            enabled: true,
            ...(group["range_select"]?.kind === "boolean"
              ? { rangeSelect: group["range_select"].value }
              : {}),
            ...(group["find"]?.kind === "boolean" ? { find: group["find"].value } : {}),
          },
    check: (state, facts) =>
      !facts.grouped &&
      facts.fields.length > 0 &&
      (!state.enabled ||
        (typeof state.rangeSelect === "boolean" &&
          typeof state.find === "boolean" &&
          (state.rangeSelect === true || state.find === true)))
        ? featureAvailable
        : featureNotPossible("definition_records_table_spreadsheet"),
  };
