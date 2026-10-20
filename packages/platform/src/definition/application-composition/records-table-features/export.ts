import {
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  settingItems,
  type RecordsTableFeatureDefinition,
} from "./shared";

/** The file formats one export offers; Excel joins through the same encoder boundary later. */
export const recordsTableExportFormats = ["csv"] as const;
export type RecordsTableExportFormat = (typeof recordsTableExportFormats)[number];

/** The most records one export may hold; the capped selection count shares this ceiling. */
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
      if (featureEnabled(group) !== true) return { enabled: false };
      const maxRows = group["max_rows"];
      return {
        enabled: true,
        formats: (settingItems(group["formats"]) ?? []).flatMap((item) =>
          item.kind === "choice" && item.value === "csv" ? (["csv"] as const) : [],
        ),
        ...(maxRows?.kind === "number" ? { maxRows: maxRows.value } : {}),
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
      if (state.formats.length === 0 || state.formats.length > recordsTableExportFormats.length)
        return featureNotPossible(code, "Choose the file format to export.");
      if (
        state.maxRows === undefined ||
        !Number.isInteger(state.maxRows) ||
        state.maxRows < 1 ||
        state.maxRows > RECORDS_TABLE_EXPORT_MAXIMUM_ROWS
      )
        return featureNotPossible(code, "Set a row limit of at most 100,000");
      return featureAvailable;
    },
  };
