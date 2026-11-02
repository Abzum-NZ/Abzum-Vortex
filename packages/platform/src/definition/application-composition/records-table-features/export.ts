import {
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  factsOf,
  factsValueType,
  optionalNumber,
  requiredChoice,
  requiredFieldList,
  requiredItems,
  type RecordsTableFeatureDefinition,
  type GridFeatureRefusal,
  type GridFeatureSettingsDeclaration,
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
 * What a file column holds. "shown" is the value exactly as the table shows it: the choice label,
 * the date in the viewer's locale and time zone, money with its currency, a number as grouped.
 * "raw" is the stored value: the choice key, the ISO date, the canonical number.
 */
export const recordsTableExportValues = ["shown", "raw"] as const;
export type RecordsTableExportValues = (typeof recordsTableExportValues)[number];

/** The business name of each way of exporting values, as the export menu shows it. */
export const recordsTableExportValuesLabels: Readonly<Record<RecordsTableExportValues, string>> = {
  shown: "As shown",
  raw: "Raw values",
};

/**
 * The one formula neutraliser for text a spreadsheet receives (export files, header labels and a
 * copied cell range): text a spreadsheet would run as a formula, including a leading full-width
 * sign, is prefixed with an apostrophe so it stays text. Quoting alone is insufficient.
 */
export const spreadsheetText = (value: string): string =>
  /^[=+\-@\t\r\n\uFF1D\uFF0B\uFF0D\uFF20]/.test(value) ? `'${value}` : value;

/** A number as the table shows it: optional sign, digits with optional grouping, optional fraction. */
export const PLAIN_NUMBER_TEXT = /^(-?)(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d+))?$/;

/**
 * The text of one CSV cell. A plain number keeps its sign; every other text goes through the one
 * formula neutraliser, so a negative amount with a currency symbol (`-NZ$5.00`) stays text.
 */
export const csvCellText = (text: string): string =>
  PLAIN_NUMBER_TEXT.test(text) ? text : spreadsheetText(text);

/** The field value types a file can hold. */
export const recordsTableExportableTypes: ReadonlySet<string> = new Set([
  "text",
  "long_text",
  "formatted_text",
  "reference_number",
  "email_address",
  "phone_number",
  "web_address",
  "choice",
  "several_choices",
  "whole_number",
  "decimal_number",
  "money",
  "yes_no",
  "date",
  "date_time",
  "link",
  "link_to_one_of_several",
]);

/** The types whose stored value reads differently from what the table shows, so Raw means something. */
export const recordsTableExportRawTypes: ReadonlySet<string> = new Set([
  "choice",
  "several_choices",
  "whole_number",
  "decimal_number",
  "money",
  "yes_no",
  "date",
  "date_time",
  "link",
  "link_to_one_of_several",
]);

/**
 * The capped selection count shares this ceiling. Excel's 1,048,576-row sheet limit exceeds
 * these 100,000 data rows plus the header.
 */
export const RECORDS_TABLE_EXPORT_MAXIMUM_ROWS = 100_000;

/**
 * Export: people download the selected rows, the current view or every matching record as a file
 * of the columns they see. `formats` are the files offered and `maxRows` the most records one
 * export holds; a selection above it is refused, never truncated. `maxRows` is absent until the
 * builder sets it, which the check refuses. A file holds each column as the table shows it;
 * `rawColumns` are the columns whose file holds the stored value instead.
 */
export type RecordsTableExportSettings = Readonly<{
  formats: readonly RecordsTableExportFormat[];
  rawColumns: readonly string[];
  maxRows?: number;
}>;

/** The feature's setting group in the Table release, off by default. */
const featureSettings = {
  kind: "group",
  key: "export",
  label: "Export",
  help: "Download the selected rows, the current view or every matching record as a file",
  required: false,
  defaultValue: {
    kind: "group",
    properties: {
      enabled: {
        kind: "boolean",
        value: false,
      },
      formats: {
        kind: "list",
        items: [
          {
            kind: "choice",
            value: "csv",
          },
        ],
      },
      raw_columns: {
        kind: "list",
        items: [],
      },
    },
  },
  properties: [
    {
      kind: "boolean",
      key: "enabled",
      label: "On",
      help: "Let people download the records they see as a file",
      required: false,
      defaultValue: {
        kind: "boolean",
        value: false,
      },
    },
    {
      kind: "list",
      key: "formats",
      label: "File formats",
      help: "The file formats people can download",
      required: false,
      minimumItems: 1,
      maximumItems: 2,
      item: {
        kind: "choice",
        key: "format",
        label: "File format",
        required: true,
        options: [
          {
            key: "csv",
            label: "CSV",
          },
          {
            key: "xlsx",
            label: "Excel",
          },
        ],
      },
      defaultValue: {
        kind: "list",
        items: [
          {
            kind: "choice",
            value: "csv",
          },
        ],
      },
    },
    {
      kind: "list",
      key: "raw_columns",
      label: "Raw value columns",
      help: "Columns whose file holds the stored value instead of what the table shows: a choice's key, a date as 2026-09-17, a number without grouping",
      required: true,
      minimumItems: 0,
      maximumItems: 200,
      item: {
        kind: "field_reference",
        key: "field",
        label: "Field",
        help: "A column of the table",
        required: true,
      },
      defaultValue: {
        kind: "list",
        items: [],
      },
    },
    {
      kind: "number",
      key: "max_rows",
      label: "Most records in one export",
      help: "The most records one export holds, up to 100,000; a larger selection is refused",
      required: false,
      integer: true,
      minimum: 1,
      maximum: 100000,
    },
  ],
} as const satisfies GridFeatureSettingsDeclaration;

/** The feature's refusals and their business sentences. */
const featureRefusal: GridFeatureRefusal = {
  code: "definition_records_table_export",
  order: 39,
  message: "Export needs the export action on the record type.",
  guidance:
    "Turn on the export action for the bound record type in Data and set a row limit of at most 100,000, or turn Export off.",
};

export const recordsTableExportFeature: RecordsTableFeatureDefinition<
  RecordsTableExportSettings,
  "export"
> &
  Readonly<{ property: "export" }> = {
  key: "export",
  property: "export",
  settings: featureSettings,
  refusals: [featureRefusal],
  onBoard: "unsupported",
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
      rawColumns: requiredFieldList(group["raw_columns"], "raw_columns"),
      ...(maxRows === undefined ? {} : { maxRows }),
    };
  },
  // Offered only to a viewer whose export permission reaches every record and who may read a column
  // the table shows; the row limit is set, as the check requires, whenever the feature is on.
  project: (state, { exportAllowed, columns, readable }) =>
    state.enabled &&
    exportAllowed &&
    state.maxRows !== undefined &&
    columns.some((column) => readable(column.field))
      ? {
          maxRows: state.maxRows,
          formats: state.formats,
          rawColumns: state.rawColumns.length > 0,
        }
      : undefined,
  // Export reads whole records, so the query must return records, and the record type must
  // declare the standard export action the viewer's permission is checked against.
  check: (state, facts) => {
    if (facts.grouped)
      return featureNotPossible(
        featureRefusal,
        "Rows that total records cannot be exported as records.",
      );
    if (!facts.exportable)
      return featureNotPossible(
        featureRefusal,
        `Export needs the export action on ${facts.recordTypeLabel || "the record type"}`,
      );
    if (!state.enabled) return featureAvailable;
    for (const field of state.rawColumns) {
      const held = factsOf(facts, field);
      if (held === undefined || !recordsTableExportRawTypes.has(factsValueType(held)))
        return featureNotPossible(
          featureRefusal,
          "Raw values apply to choices, numbers, money, yes/no, dates and links of the table's query.",
        );
    }
    if (
      state.formats.length === 0 ||
      state.formats.length > recordsTableExportFormats.length ||
      new Set(state.formats).size !== state.formats.length
    )
      return featureNotPossible(featureRefusal, "Choose the file format to export.");
    if (
      state.maxRows === undefined ||
      !Number.isInteger(state.maxRows) ||
      state.maxRows < 1 ||
      state.maxRows > RECORDS_TABLE_EXPORT_MAXIMUM_ROWS
    )
      return featureNotPossible(
        featureRefusal,
        state.formats.includes("xlsx")
          ? "Excel export needs a row limit of at most 100,000"
          : "Set a row limit of at most 100,000",
      );
    return featureAvailable;
  },
};
