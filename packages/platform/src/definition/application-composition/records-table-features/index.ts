import {
  RECORDS_TABLE_UNVIRTUALIZED_ROW_LIMIT,
  UnreadableSettingError,
  requiredGroup,
  withSettingPath,
} from "./shared";
import {
  recordsTableSpreadsheetFeature,
  type RecordsTableSpreadsheetSettings,
} from "./spreadsheet";

export {
  RECORDS_TABLE_STATUS_BAR_MAXIMUM_FIELDS,
  recordsTableStatusBarFieldTypes,
  recordsTableStatusBarOperations,
  type RecordsTableStatusBarOperation,
} from "./spreadsheet";
import type { ComponentSettingValue } from "../block-property-schema";
import {
  boardFilterProblem,
  boardFormattingProblem,
  recordsTableBoardFeature,
  type RecordsTableBoardMode,
  type RecordsTableBoardSettings,
} from "./board";
import {
  recordsTableBulkActionsFeature,
  type RecordsTableBulkActionsSettings,
} from "./bulk-actions";

export {
  recordsTableBulkActionRecordLimit,
  type RecordsTableBulkActionContract,
} from "./bulk-actions";
import {
  recordsTableColumnFiltersFeature,
  type RecordsTableColumnFiltersSettings,
} from "./column-filters";

export {
  recordsTableFieldFilterable,
  recordsTableFilterKindOf,
  recordsTableFilterKinds,
  type RecordsTableFilterKind,
} from "./column-filters";
import { recordsTableRowActionsFeature } from "./row-actions";
import { recordsTableRowEditFeature, type RecordsTableRowEditSettings } from "./row-edit";
import { recordsTableInlineEditFeature, type RecordsTableInlineEditSettings } from "./inline-edit";
import {
  recordsTableMasterDetailFeature,
  type RecordsTableMasterDetailSettings,
} from "./master-detail";
import {
  RECORDS_TABLE_TREE_MAXIMUM_PAGE_SIZE,
  recordsTableTreeFeature,
  type RecordsTableTreeSettings,
} from "./tree";
import {
  recordsTableConditionalFormattingFeature,
  type RecordsTableConditionalFormattingSettings,
} from "./conditional-formatting";
import { recordsTableSavedViewsFeature, type RecordsTableSavedViewsSettings } from "./saved-views";
import { recordsTableSearchFeature, type RecordsTableSearchSettings } from "./search";
import { recordsTablePinningFeature, type RecordsTablePinningSettings } from "./pinning";
import { recordsTablePivotFeature, type RecordsTablePivotSettings } from "./pivot";
import {
  recordsTableGroupedQueryRefusal,
  recordsTableGroupingFeature,
  type RecordsTableGroupingSettings,
} from "./grouping";
import { recordsTableExportFeature, type RecordsTableExportSettings } from "./export";
import {
  featureAvailable,
  featureNotPossible,
  type RecordsTableFeatureCheck,
  type RecordsTableFeatureRefusalCode,
  type RecordsTableFeatureDefinition,
  type RecordsTableFeatureState,
  type RecordsTableQueryFacts,
} from "./shared";

export {
  factsValueType,
  recordsTablePivotDateUnits,
  recordsTableEditableFieldTypes,
  recordsTableFieldNotEditableReason,
  type RecordsTableBoardFacts,
  type RecordsTableFeatureCheck,
  type RecordsTableFeatureState,
  type RecordsTableFieldFacts,
  type RecordsTablePivotDateUnit,
  type RecordsTableQueryFacts,
  type RecordsTableRelatedRecordsFacts,
} from "./shared";
export {
  recordsTableActionCapabilities,
  recordsTableRowActionIcons,
  type RecordsTableActionContract,
} from "./row-actions";
export {
  RECORDS_TABLE_EXPORT_MAXIMUM_ROWS,
  recordsTableExportFormatLabels,
  recordsTableExportFormats,
  spreadsheetText,
  type RecordsTableExportFormat,
} from "./export";
export { RECORDS_TABLE_TREE_MAXIMUM_PAGE_SIZE } from "./tree";
export {
  checkRecordsTableGrouping,
  groupingDefaultsFromQuery,
  recordsTableGroupingFieldTypes,
  type RecordsTableGroupingFacts,
  type RecordsTableGroupingFieldType,
} from "./grouping";
export { boardFilterProblem, boardProblem, recordsTableBoardFactsOf } from "./board";
export {
  conditionalColumnFormatFieldTypes,
  conditionalColumnFormatIssue,
  conditionalFormatFactsOf,
  conditionalFormatIcons,
  conditionalFormatRuleFields,
  conditionalFormatRuleIssue,
  conditionalFormatTokens,
  conditionalFormattingDateParameters,
  type ConditionalColumnFormat,
  type ConditionalFormatIcon,
  type ConditionalFormatRule,
  type ConditionalFormatStyle,
  type ConditionalFormatToken,
  type ConditionalFormattingDateParameter,
} from "./conditional-formatting";
export type {
  RecordsTableBoardMode,
  RecordsTableBoardSettings,
  RecordsTableConditionalFormattingSettings,
  RecordsTableExportSettings,
  RecordsTableBulkActionsSettings,
  RecordsTableColumnFiltersSettings,
  RecordsTableInlineEditSettings,
  RecordsTableRowEditSettings,
  RecordsTableMasterDetailSettings,
  RecordsTableTreeSettings,
  RecordsTableGroupingSettings,
  RecordsTableSavedViewsSettings,
  RecordsTableSearchSettings,
  RecordsTablePinningSettings,
  RecordsTablePivotSettings,
  RecordsTableSpreadsheetSettings,
};

/**
 * The optional grid features of the Records table, each authored in the table's one `features`
 * setting group as `{ enabled, ...its settings }` and off by default. Sorting, columns, density and
 * sticky headings are the grid itself, always available, and are not features. This registry is the
 * one gate: publication, Studio and the server projection all call the same check, and the UI loads
 * a feature's code only when the projection turns it on. A new feature adds its file here, a
 * Studio editor (`@vortex/ui/studio` grid features) and a UI chunk (`display/grid-features`).
 */
export type RecordsTableFeatures = Readonly<{
  search: RecordsTableFeatureState<RecordsTableSearchSettings>;
  columnFilters: RecordsTableFeatureState<RecordsTableColumnFiltersSettings>;
  savedViews: RecordsTableFeatureState<RecordsTableSavedViewsSettings>;
  bulkActions: RecordsTableFeatureState<RecordsTableBulkActionsSettings>;
  inlineEdit: RecordsTableFeatureState<RecordsTableInlineEditSettings>;
  rowEdit: RecordsTableFeatureState<RecordsTableRowEditSettings>;
  rowActions: RecordsTableFeatureState<object>;
  masterDetail: RecordsTableFeatureState<RecordsTableMasterDetailSettings>;
  tree: RecordsTableFeatureState<RecordsTableTreeSettings>;
  grouping: RecordsTableFeatureState<RecordsTableGroupingSettings>;
  conditionalFormatting: RecordsTableFeatureState<RecordsTableConditionalFormattingSettings>;
  pinning: RecordsTableFeatureState<RecordsTablePinningSettings>;
  pivot: RecordsTableFeatureState<RecordsTablePivotSettings>;
  spreadsheet: RecordsTableFeatureState<RecordsTableSpreadsheetSettings>;
  board: RecordsTableFeatureState<RecordsTableBoardSettings>;
  export: RecordsTableFeatureState<RecordsTableExportSettings>;
}>;

const registry = {
  spreadsheet: { property: "spreadsheet", definition: recordsTableSpreadsheetFeature },
  pinning: { property: "pinning", definition: recordsTablePinningFeature },
  search: { property: "search", definition: recordsTableSearchFeature },
  column_filters: { property: "columnFilters", definition: recordsTableColumnFiltersFeature },
  saved_views: { property: "savedViews", definition: recordsTableSavedViewsFeature },
  bulk_actions: { property: "bulkActions", definition: recordsTableBulkActionsFeature },
  inline_edit: { property: "inlineEdit", definition: recordsTableInlineEditFeature },
  row_edit: { property: "rowEdit", definition: recordsTableRowEditFeature },
  row_actions: { property: "rowActions", definition: recordsTableRowActionsFeature },
  master_detail: { property: "masterDetail", definition: recordsTableMasterDetailFeature },
  tree: { property: "tree", definition: recordsTableTreeFeature },
  grouping: { property: "grouping", definition: recordsTableGroupingFeature },
  conditional_formatting: {
    property: "conditionalFormatting",
    definition: recordsTableConditionalFormattingFeature,
  },
  pivot: { property: "pivot", definition: recordsTablePivotFeature },
  board: { property: "board", definition: recordsTableBoardFeature },
  export: { property: "export", definition: recordsTableExportFeature },
} as const satisfies Record<
  string,
  Readonly<{
    property: keyof RecordsTableFeatures;
    definition: RecordsTableFeatureDefinition<object>;
  }>
>;

/** The feature keys in the order Studio lists them; each is a key of the `features` setting group. */
export const recordsTableFeatureKeys = [
  "spreadsheet",
  "pinning",
  "search",
  "column_filters",
  "saved_views",
  "bulk_actions",
  "inline_edit",
  "row_edit",
  "row_actions",
  "master_detail",
  "tree",
  "grouping",
  "conditional_formatting",
  "pivot",
  "board",
  "export",
] as const satisfies readonly (keyof typeof registry)[];
export type RecordsTableFeatureKey = (typeof recordsTableFeatureKeys)[number];

/** A feature's business name and one-line description, for Studio's Features list. */
export const recordsTableFeatureDescription = (
  key: RecordsTableFeatureKey,
): Readonly<{ label: string; description: string }> => ({
  label: registry[key].definition.label,
  description: registry[key].definition.description,
});

/** One feature's state in a read contract. */
export const recordsTableFeatureState = (
  features: RecordsTableFeatures,
  key: RecordsTableFeatureKey,
): RecordsTableFeatureState<object> => features[registry[key].property];

/** The `features` setting group read whole, or the path of the setting that cannot be read. */
type RecordsTableFeaturesRead =
  | Readonly<{ kind: "read"; features: RecordsTableFeatures }>
  | Readonly<{ kind: "unreadable"; path: string }>;

/**
 * Reads the `features` setting group. The catalogue default fills in every feature, so a group
 * that is missing, a feature that does not say whether it is on, or a feature with a setting or
 * list entry it cannot read is unreadable, naming the part: no renderer or server ever guesses a
 * feature the definition did not decide, and a partial entry never disappears.
 */
export const readRecordsTableFeatures = (
  value: ComponentSettingValue | undefined,
): RecordsTableFeaturesRead => {
  try {
    const group = requiredGroup(value, "features");
    const read = <Key extends RecordsTableFeatureKey>(key: Key): RecordsTableFeatureState<object> =>
      withSettingPath(`features.${key}`, () =>
        registry[key].definition.read(requiredGroup(group[key], "group")),
      );
    const states = Object.fromEntries(
      recordsTableFeatureKeys.map((key) => [registry[key].property, read(key)]),
    );
    return { kind: "read", features: states as RecordsTableFeatures };
  } catch (error) {
    if (error instanceof UnreadableSettingError) return { kind: "unreadable", path: error.path };
    throw error;
  }
};

/**
 * The features of a `features` setting group, or undefined after logging where it cannot be read.
 * `where` names the caller, so the log says which read refused the group.
 */
export const recordsTableFeaturesOrLog = (
  value: ComponentSettingValue | undefined,
  where: string,
): RecordsTableFeatures | undefined => {
  const read = readRecordsTableFeatures(value);
  if (read.kind === "read") return read.features;
  console.error(`[grid] ${where} refused: DATA_GRID_SETTING_UNREADABLE path=${read.path}`);
  return undefined;
};

/**
 * The features a board view implements beside Board itself. A feature not listed is refused when
 * it is on together with Board: the board draws cards, not table rows, and never ignores a feature.
 * A card opens through Row actions, the cards narrow through Column filters, which a board
 * reads over every field of its record type, and Formatting colours whole cards.
 */
const recordsTableBoardSupportedFeatures: readonly RecordsTableFeatureKey[] = [
  "row_actions",
  "column_filters",
  "conditional_formatting",
];

/**
 * Whether the table must be grouped to read its query: a grouped query has no flat rows, so a
 * table that reads one (and is not a board, which reads it its own way) shows its records in
 * groups. Publication refuses such a table while Group by is off, even though the feature is off.
 */
export const recordsTableGroupingRequired = (
  features: RecordsTableFeatures,
  facts: RecordsTableQueryFacts,
): boolean => facts.grouped && !features.board.enabled;

/**
 * The one capability check of one feature against the bound query's facts. Publication runs it on
 * the compiled release for every enabled feature and refuses with its sentence; Studio runs it on
 * the draft's facts beside each switch, so the two never disagree.
 */
export const checkRecordsTableFeature = (
  key: RecordsTableFeatureKey | "viewport",
  state: RecordsTableFeatureState<object>,
  facts: RecordsTableQueryFacts,
  presentation: "grid" | "cards",
  features: RecordsTableFeatures,
  /** The table's own page size; the tree's opened levels share one row budget with it. */
  tablePageSize: number | undefined,
): RecordsTableFeatureCheck => {
  if (key === "viewport")
    return facts.table.viewport === "page" &&
      tablePageSize !== undefined &&
      tablePageSize > RECORDS_TABLE_UNVIRTUALIZED_ROW_LIMIT
      ? featureNotPossible("definition_records_table_bounded_scrolling")
      : featureAvailable;
  if (
    key === "board" &&
    state.enabled &&
    features.rowActions.enabled &&
    facts.table.rowActions.length !== 1
  )
    return featureNotPossible("definition_records_table_board_row_action");
  if (
    key === "row_actions" &&
    state.enabled &&
    facts.table.rowActions.filter((action) => action.placement === "inline").length > 3
  )
    return featureNotPossible("definition_records_table_row_action_limit");
  if (presentation === "cards" && key === "spreadsheet")
    return featureNotPossible(
      "definition_records_table_spreadsheet",
      "Spreadsheet controls need the Table preset. Lists do not have a cell range.",
    );
  if (presentation === "cards" && key === "inline_edit")
    return featureNotPossible(
      "definition_records_table_inline_edit",
      "Inline editing needs the Table preset. Open a record to edit it from a List.",
    );
  if (presentation === "cards" && key === "pinning")
    return featureNotPossible(
      "definition_records_table_pinning",
      "Column pinning needs the Table preset. Lists have no scrolling columns.",
    );
  if (key === "tree" && state.enabled && features.board.enabled)
    return featureNotPossible(
      "definition_records_table_tree",
      "Turn Board off to show records as a tree.",
    );
  // Paste and fill write through the table's inline edit, so they need it on with a field to change.
  if (
    key === "spreadsheet" &&
    features.spreadsheet.enabled &&
    (features.spreadsheet.paste || features.spreadsheet.fill) &&
    (!features.inlineEdit.enabled || features.inlineEdit.fields.length === 0)
  )
    return featureNotPossible(
      "definition_records_table_spreadsheet",
      "Paste and fill need Inline editing and at least one editable field",
    );
  // A row opens one panel: its related records or the records beneath it, never both.
  if (key === "tree" && state.enabled && features.masterDetail.enabled)
    return featureNotPossible(
      "definition_records_table_tree",
      "A row shows either its related records or the records beneath it; turn Related records off to use a tree.",
    );
  // Personal rules are evaluated by the table's own formatting, so they need it on.
  if (
    key === "saved_views" &&
    state.enabled &&
    (state as Extract<RecordsTableFeatures["savedViews"], { enabled: true }>).personalFormatting &&
    !features.conditionalFormatting.enabled
  )
    return featureNotPossible(
      "definition_records_table_saved_views",
      "People can only add their own formatting when Formatting is on for this table. Turn Formatting on, or turn personal formatting off.",
    );
  if (key === "grouping" && !state.enabled && recordsTableGroupingRequired(features, facts))
    return recordsTableGroupedQueryRefusal(facts);
  // Groups, a board's columns, a tree's levels and a pivot's cells each arrange the records
  // their own way, so the table shows one of them at a time.
  if (key === "grouping" && state.enabled) {
    const other = features.board.enabled
      ? "Board"
      : features.tree.enabled
        ? "Tree"
        : features.pivot.enabled
          ? "Pivot"
          : undefined;
    if (other !== undefined)
      return featureNotPossible(
        "definition_records_table_grouping",
        `Turn ${other} off to group the records.`,
      );
  }
  // A board draws cards, not table rows, so a feature the board view does not implement is
  // refused rather than silently ignored. Grouping and tree carry their own sentences above.
  if (
    state.enabled &&
    features.board.enabled &&
    key !== "board" &&
    key !== "grouping" &&
    key !== "tree" &&
    !recordsTableBoardSupportedFeatures.includes(key)
  )
    return featureNotPossible(
      `definition_records_table_${key}` as RecordsTableFeatureRefusalCode,
      `${registry[key].definition.label} is not available on a board yet: turn Board off to use it, or turn ${registry[key].definition.label} off.`,
    );
  // The board reads its own grouped query, which the board check judges; a table-row check of a
  // feature the board borrows would refuse that query.
  if (
    features.board.enabled &&
    key !== "board" &&
    recordsTableBoardSupportedFeatures.includes(key)
  ) {
    if (key === "column_filters" && state.enabled && facts.board !== undefined)
      return (
        boardFilterProblem(
          (state as Extract<RecordsTableFeatures["columnFilters"], { enabled: true }>).fields,
          facts.board,
        ) ?? featureAvailable
      );
    if (key === "conditional_formatting" && state.enabled && facts.board !== undefined)
      return (
        boardFormattingProblem(
          state as Extract<RecordsTableFeatures["conditionalFormatting"], { enabled: true }>,
          facts.board,
        ) ?? featureAvailable
      );
    return featureAvailable;
  }
  const check = (registry[key].definition as RecordsTableFeatureDefinition<object>).check(
    state,
    facts,
  );
  // The table's page and one page of child records must fit the rows a tree table holds at once.
  const childPageSize = features.tree.enabled ? features.tree.childPageSize : undefined;
  if (
    key === "tree" &&
    check.kind !== "not_possible" &&
    childPageSize !== undefined &&
    tablePageSize !== undefined &&
    tablePageSize + childPageSize > RECORDS_TABLE_TREE_MAXIMUM_PAGE_SIZE
  )
    return featureNotPossible(
      "definition_records_table_tree",
      `A tree table shows at most ${RECORDS_TABLE_TREE_MAXIMUM_PAGE_SIZE} rows at once: its ${tablePageSize} records a page and ${childPageSize} child records at a time do not fit. Lower one of them.`,
    );
  return check;
};

/** Every feature's state and check, in Studio's order. */
export const checkRecordsTableFeatures = (
  features: RecordsTableFeatures,
  facts: RecordsTableQueryFacts,
  presentation: "grid" | "cards",
  tablePageSize: number | undefined,
): readonly Readonly<{
  key: RecordsTableFeatureKey | "viewport";
  enabled: boolean;
  check: RecordsTableFeatureCheck;
}>[] => [
  {
    key: "viewport",
    enabled: true,
    check: checkRecordsTableFeature(
      "viewport",
      { enabled: true },
      facts,
      presentation,
      features,
      tablePageSize,
    ),
  },
  ...recordsTableFeatureKeys.map((key) => {
    const state = recordsTableFeatureState(features, key);
    return {
      key,
      enabled: state.enabled,
      check: checkRecordsTableFeature(key, state, facts, presentation, features, tablePageSize),
    };
  }),
];

/**
 * The feature whose controls raise each Records table event it owns, and the switch of that
 * feature that offers the control when only part of the feature raises it.
 */
const featureEvents: Readonly<
  Record<string, Readonly<{ feature: RecordsTableFeatureKey; offeredBy?: string }>>
> = {
  search_changed: { feature: "search" },
  filter_changed: { feature: "column_filters" },
  inline_edit: { feature: "inline_edit" },
  row_edit: { feature: "row_edit" },
  row_action: { feature: "row_actions" },
  card_moved: { feature: "board" },
  card_added: { feature: "board", offeredBy: "quick_add" },
};

/** The feature whose controls raise this Records table event, for the events a feature owns. */
export const recordsTableFeatureOfEvent = (event: string): RecordsTableFeatureKey | undefined =>
  Object.hasOwn(featureEvents, event) ? featureEvents[event]!.feature : undefined;

/**
 * Whether an authored placement's plain `features` setting raises this event: its feature is on
 * and, for an event only part of the feature raises, that part's switch is on. The catalogue
 * default leaves every feature off, so a placement that sets no features raises none. An event no
 * feature owns is always raised. A binding compiles only while its event is raised, so the server
 * starts no flow for an event the placement does not raise, and Studio offers the event by it.
 */
export const authoredRecordsTableEventAvailable = (
  props: Readonly<Record<string, unknown>>,
  event: string,
): boolean => {
  if (!Object.hasOwn(featureEvents, event)) return true;
  const { feature: key, offeredBy } = featureEvents[event]!;
  const features = props["features"];
  if (features === null || typeof features !== "object") return false;
  const feature = (features as Record<string, unknown>)[key];
  if (feature === null || typeof feature !== "object") return false;
  const group = feature as Record<string, unknown>;
  return group["enabled"] === true && (offeredBy === undefined || group[offeredBy] === true);
};
