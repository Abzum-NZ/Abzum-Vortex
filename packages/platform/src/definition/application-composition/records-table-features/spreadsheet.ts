import { projectionFieldKeySchema as fieldKeySchema } from "./shared";
import { z } from "zod";
import {
  factsOf,
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  projectedEditableFields,
  requiredBoolean,
  requiredChoice,
  requiredFieldList,
  requiredItems,
  type RecordsTableFeatureDefinition,
  type GridFeatureRefusal,
  type GridFeatureSettingsDeclaration,
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

/** The feature's setting group in the Table release, off by default. */
const featureSettings = {
  kind: "group",
  key: "spreadsheet",
  label: "Spreadsheet controls",
  help: "Select ranges and find values within the loaded page",
  required: true,
  properties: [
    {
      kind: "boolean",
      key: "enabled",
      label: "Spreadsheet controls",
      required: true,
      defaultValue: {
        kind: "boolean",
        value: false,
      },
    },
    {
      kind: "boolean",
      key: "range_select",
      label: "Range selection",
      help: "Shift and arrows, Shift and click, or drag; Ctrl+A selects this page",
      required: false,
      defaultValue: {
        kind: "boolean",
        value: false,
      },
    },
    {
      kind: "boolean",
      key: "find",
      label: "Find on page",
      help: "Find values on this page; Ctrl+F opens the finder",
      required: false,
      defaultValue: {
        kind: "boolean",
        value: false,
      },
    },
    {
      kind: "boolean",
      key: "paste",
      label: "Paste",
      help: "Paste copied cells into a selected range; every cell is checked on the server and all change or none",
      required: false,
      defaultValue: {
        kind: "boolean",
        value: false,
      },
    },
    {
      kind: "boolean",
      key: "fill",
      label: "Fill down",
      help: "Ctrl+D copies the top cell of a selected range down the range",
      required: false,
      defaultValue: {
        kind: "boolean",
        value: false,
      },
    },
    {
      kind: "boolean",
      key: "undo",
      label: "Undo",
      help: "Ctrl+Z and Ctrl+Y undo and redo the batches committed in this session",
      required: false,
      defaultValue: {
        kind: "boolean",
        value: false,
      },
    },
    {
      kind: "list",
      key: "status_bar_fields",
      label: "Status bar fields",
      help: "Number, money and date fields whose selected values the status bar totals; leave empty for no status bar",
      required: false,
      minimumItems: 0,
      maximumItems: 20,
      item: {
        kind: "field_reference",
        key: "field",
        label: "Field",
        help: "Field of the bound query the status bar totals",
        required: true,
        fieldTypes: ["whole_number", "decimal_number", "money", "date", "date_time"],
      },
      defaultValue: {
        kind: "list",
        items: [],
      },
    },
    {
      kind: "list",
      key: "status_bar_operations",
      label: "Status bar totals",
      help: "The totals the status bar shows for each field",
      required: false,
      minimumItems: 0,
      maximumItems: 5,
      item: {
        kind: "choice",
        key: "operation",
        label: "Total",
        required: true,
        options: [
          {
            key: "count",
            label: "Count",
          },
          {
            key: "sum",
            label: "Sum",
          },
          {
            key: "average",
            label: "Average",
          },
          {
            key: "minimum",
            label: "Minimum",
          },
          {
            key: "maximum",
            label: "Maximum",
          },
        ],
      },
      defaultValue: {
        kind: "list",
        items: [],
      },
    },
  ],
  defaultValue: {
    kind: "group",
    properties: {
      enabled: {
        kind: "boolean",
        value: false,
      },
      range_select: {
        kind: "boolean",
        value: false,
      },
      find: {
        kind: "boolean",
        value: false,
      },
      paste: {
        kind: "boolean",
        value: false,
      },
      fill: {
        kind: "boolean",
        value: false,
      },
      undo: {
        kind: "boolean",
        value: false,
      },
      status_bar_fields: {
        kind: "list",
        items: [],
      },
      status_bar_operations: {
        kind: "list",
        items: [],
      },
    },
  },
} as const satisfies GridFeatureSettingsDeclaration;

/** The feature's refusals and their business sentences. */
const featureRefusal: GridFeatureRefusal = {
  code: "definition_records_table_spreadsheet",
  order: 39,
  message:
    "Spreadsheet controls need individual records with fields and at least one control enabled.",
  guidance:
    "Choose an ungrouped query and enable Range selection or Find on page, or turn Spreadsheet controls off.",
};

const onlyTrue = z.literal(true);
const spreadsheetSchema = z
  .object({
    rangeSelect: z.boolean(),
    find: z.boolean(),
    /** Paste, fill down and undo of batches; each is present only when usable now. */
    paste: onlyTrue.optional(),
    fill: onlyTrue.optional(),
    undo: onlyTrue.optional(),
    /**
     * The status bar of a selected range: the configured fields (every one is shown, a field the
     * viewer cannot read as "Not available") and the totals. Absent while the status bar is off.
     */
    statusBar: z
      .object({
        fields: z
          .array(fieldKeySchema)
          .min(1)
          .max(RECORDS_TABLE_STATUS_BAR_MAXIMUM_FIELDS)
          .readonly(),
        operations: z.array(z.enum(recordsTableStatusBarOperations)).min(1).readonly(),
      })
      .strict()
      .readonly()
      .refine(
        (bar) =>
          new Set(bar.fields).size === bar.fields.length &&
          new Set(bar.operations).size === bar.operations.length,
        "The status bar names each field and total once",
      )
      .optional(),
  })
  .strict()
  .readonly()
  .refine((controls) => controls.rangeSelect || controls.find, {
    message: "Spreadsheet controls need an enabled control",
  })
  .refine(
    (controls) =>
      !(controls.undo === true && controls.paste !== true && controls.fill !== true) &&
      !((controls.paste === true || controls.fill === true) && !controls.rangeSelect),
    { message: "Paste, fill and undo need a range and an edit" },
  )
  .refine((controls) => controls.statusBar === undefined || controls.rangeSelect, {
    message: "The status bar needs a range",
  });

const projectionSchema = spreadsheetSchema;

export const recordsTableSpreadsheetFeature: RecordsTableFeatureDefinition<
  RecordsTableSpreadsheetSettings,
  "spreadsheet"
> &
  Readonly<{ property: "spreadsheet"; projectionSchema: typeof projectionSchema }> = {
  key: "spreadsheet",
  property: "spreadsheet",
  projectionSchema,
  settings: featureSettings,
  refusals: [featureRefusal],
  onBoard: "unsupported",
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
  project: (state, context) => {
    const { columns, features, readable } = context;
    if (!state.enabled || !columns.some((column) => readable(column.field))) return undefined;
    // A status bar total names only fields the table shows as columns.
    const statusBarFields = state.statusBarFields.filter((field) =>
      columns.some((column) => column.field.toLowerCase() === field.toLowerCase()),
    );
    const batchEditable =
      state.rangeSelect && projectedEditableFields(features.inlineEdit, context).length > 0;
    const pasteUsable = batchEditable && state.paste;
    const fillUsable = batchEditable && state.fill;
    const undoUsable = (pasteUsable || fillUsable) && state.undo;
    return {
      rangeSelect: state.rangeSelect,
      find: state.find,
      ...(pasteUsable ? { paste: true as const } : {}),
      ...(fillUsable ? { fill: true as const } : {}),
      ...(undoUsable ? { undo: true as const } : {}),
      ...(state.rangeSelect && statusBarFields.length > 0 && state.statusBarOperations.length > 0
        ? { statusBar: { fields: statusBarFields, operations: state.statusBarOperations } }
        : {}),
    };
  },
  conflicts: (_state, _facts, { features, presentation }) => {
    if (presentation === "cards")
      return featureNotPossible(
        featureRefusal,
        "Spreadsheet controls need the Table preset. Lists do not have a cell range.",
      );
    // Paste and fill write through the table's inline edit, so they need it on with a field to change.
    if (
      features.spreadsheet.enabled &&
      (features.spreadsheet.paste || features.spreadsheet.fill) &&
      (!features.inlineEdit.enabled || features.inlineEdit.fields.length === 0)
    )
      return featureNotPossible(
        featureRefusal,
        "Paste and fill need Inline editing and at least one editable field",
      );
    return undefined;
  },
  check: (state, facts) => {
    if (facts.grouped || facts.fields.length === 0) return featureNotPossible(featureRefusal);
    if (!state.enabled) return featureAvailable;
    if (!state.rangeSelect && !state.find) return featureNotPossible(featureRefusal);
    if (state.undo && !state.paste && !state.fill)
      return featureNotPossible(featureRefusal, "Undo needs Paste or Fill");
    if ((state.paste || state.fill) && !state.rangeSelect)
      return featureNotPossible(featureRefusal, "Paste and fill need Range selection turned on.");
    const { statusBarFields: fields, statusBarOperations: operations } = state;
    if (fields.length === 0 && operations.length === 0) return featureAvailable;
    if (!state.rangeSelect)
      return featureNotPossible(
        featureRefusal,
        "Status bar totals need Range selection turned on.",
      );
    if (fields.length === 0 || operations.length === 0)
      return featureNotPossible(
        featureRefusal,
        "Choose both the fields and the totals the status bar shows, or clear both.",
      );
    if (
      fields.length > RECORDS_TABLE_STATUS_BAR_MAXIMUM_FIELDS ||
      new Set(fields.map((field) => field.toLowerCase())).size !== fields.length ||
      new Set(operations).size !== operations.length
    )
      return featureNotPossible(
        featureRefusal,
        `Choose each status bar field and total once, at most ${RECORDS_TABLE_STATUS_BAR_MAXIMUM_FIELDS} fields.`,
      );
    for (const field of fields) {
      const held = factsOf(facts, field);
      if (held === undefined || !recordsTableStatusBarFieldTypes.includes(held.type))
        return featureNotPossible(
          featureRefusal,
          "Status bar totals need a number, money or date field the query reads",
        );
      if (!facts.columnFieldIds.some((column) => column.toLowerCase() === field.toLowerCase()))
        return featureNotPossible(
          featureRefusal,
          "Status bar totals need a field the table shows as a column.",
        );
    }
    return featureAvailable;
  },
};
