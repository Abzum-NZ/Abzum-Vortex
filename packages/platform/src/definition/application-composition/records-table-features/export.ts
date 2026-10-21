import {
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  optionalNumber,
  requiredChoice,
  requiredItems,
  type RecordsTableFeatureDefinition,
} from "./shared";

/** The file formats offered through the one export authority and transport. */
export const recordsTableExportFormats = ["csv", "xlsx"] as const;
export type RecordsTableExportFormat = (typeof recordsTableExportFormats)[number];

/** The business name of each file format, as the export menu and Studio show it. */
export const recordsTableExportFormatLabels: Readonly<Record<RecordsTableExportFormat, string>> = {
  csv: "CSV",
  xlsx: "Excel",
};

/**
 * The one formula neutraliser for text a spreadsheet receives (export files, header labels and a
 * copied cell range): text a spreadsheet would run as a formula, including a leading full-width
 * sign, is prefixed with an apostrophe so it stays text. Quoting alone is insufficient.
 */
export const spreadsheetText = (value: string): string =>
  /^[=+\-@\t\r\n\uFF1D\uFF0B\uFF0D\uFF20]/.test(value) ? `'${value}` : value;

/**
 * The capped selection count shares this ceiling. Excel's 1,048,576-row sheet limit exceeds
 * these 100,000 data rows plus the header.
 */
export const RECORDS_TABLE_EXPORT_MAXIMUM_ROWS = 100_000;

/**
 * Export: people download the selected rows, the current view or every matching record as a file
 * of the columns they see. `formats` are the files offered and `maxRows` the most records one
 * export holds; a selection above it is refused, never truncated. `maxRows` is absent until the
 * builder sets it, which the check refuses.
 */
export type RecordsTableExportSettings = Readonly<{
  formats: readonly RecordsTableExportFormat[];
  maxRows?: number;
}>;

const code = "definition_records_table_export" as const;

export const recordsTableExportFeature: RecordsTableFeatureDefinition<RecordsTableExportSettings> =
  {
    key: "export",
    label: "Export",
    description: "Download the selected rows, the current view or every matching record as a file",
    read: (group) => {
      if (!featureEnabled(group)) return { enabled: false };
      const maxRows = optionalNumber(group["max_rows"], "max_rows");
      return {
        enabled: true,
        formats: requiredItems(group["formats"], "formats").map((item, index) =>
          requiredChoice(item, recordsTableExportFormats, `formats[${index}]`),
        ),
        ...(maxRows === undefined ? {} : { maxRows }),
      };
    },
    // Export reads whole records, so the query must return records, and the record type must
    // declare the standard export action the viewer's permission is checked against.
    check: (state, facts) => {
      if (facts.grouped)
        return featureNotPossible(code, "Rows that total records cannot be exported as records.");
      if (!facts.exportable)
        return featureNotPossible(
          code,
          `Export needs the export action on ${facts.recordTypeLabel || "the record type"}`,
        );
      if (!state.enabled) return featureAvailable;
      if (
        state.formats.length === 0 ||
        state.formats.length > recordsTableExportFormats.length ||
        new Set(state.formats).size !== state.formats.length
      )
        return featureNotPossible(code, "Choose the file format to export.");
      if (
        state.maxRows === undefined ||
        !Number.isInteger(state.maxRows) ||
        state.maxRows < 1 ||
        state.maxRows > RECORDS_TABLE_EXPORT_MAXIMUM_ROWS
      )
        return featureNotPossible(
          code,
          state.formats.includes("xlsx")
            ? "Excel export needs a row limit of at most 100,000"
            : "Set a row limit of at most 100,000",
        );
      return featureAvailable;
    },
  };
