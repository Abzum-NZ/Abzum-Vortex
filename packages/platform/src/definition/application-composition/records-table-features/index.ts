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
import { recordsTableTreeFeature, type RecordsTableTreeSettings } from "./tree";
import {
  recordsTableConditionalFormattingFeature,
  type RecordsTableConditionalFormattingSettings,
} from "./conditional-formatting";
import { recordsTableSavedViewsFeature, type RecordsTableSavedViewsSettings } from "./saved-views";
import { recordsTableSearchFeature, type RecordsTableSearchSettings } from "./search";
import { recordsTablePinningFeature, type RecordsTablePinningSettings } from "./pinning";
import { recordsTablePivotFeature, type RecordsTablePivotSettings } from "./pivot";
import { recordsTableGroupingFeature, type RecordsTableGroupingSettings } from "./grouping";
import { recordsTableTotalsFeature, type RecordsTableTotalsSettings } from "./totals";
export { recordsTableAggregateSupportsType } from "./totals";
export type { RecordsTableTotalsSettings } from "./totals";
import { recordsTableExportFeature, type RecordsTableExportSettings } from "./export";
import {
  featureAvailable,
  featureNotPossible,
  type GridFeatureRefusal,
  type RecordsTableFeatureCheck,
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
export { boardProblem, recordsTableBoardFactsOf } from "./board";
export { boardFilterProblem } from "./column-filters";
export { boardFormattingProblem } from "./conditional-formatting";
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
  totals: RecordsTableFeatureState<RecordsTableTotalsSettings>;
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

export {
  recordsTableBoardFeature,
  recordsTableBulkActionsFeature,
  recordsTableColumnFiltersFeature,
  recordsTableConditionalFormattingFeature,
  recordsTableExportFeature,
  recordsTableGroupingFeature,
  recordsTableInlineEditFeature,
  recordsTableMasterDetailFeature,
  recordsTablePinningFeature,
  recordsTablePivotFeature,
  recordsTableRowActionsFeature,
  recordsTableRowEditFeature,
  recordsTableSavedViewsFeature,
  recordsTableSearchFeature,
  recordsTableSpreadsheetFeature,
  recordsTableTotalsFeature,
  recordsTableTreeFeature,
};

/**
 * Every grid feature definition, in the order the Table release declares their setting groups.
 * The registry, the feature keys, the release's `features` group and its defaults, the refusal
 * catalogue and the events the features raise are all derived from these definitions.
 */
export const recordsTableFeatureDefinitions = [
  recordsTableSearchFeature,
  recordsTableColumnFiltersFeature,
  recordsTableSavedViewsFeature,
  recordsTableBulkActionsFeature,
  recordsTableInlineEditFeature,
  recordsTableRowEditFeature,
  recordsTableConditionalFormattingFeature,
  recordsTableMasterDetailFeature,
  recordsTableTreeFeature,
  recordsTableGroupingFeature,
  recordsTablePinningFeature,
  recordsTableBoardFeature,
  recordsTablePivotFeature,
  recordsTableExportFeature,
  recordsTableSpreadsheetFeature,
  recordsTableRowActionsFeature,
  recordsTableTotalsFeature,
] as const;

type Definition = (typeof recordsTableFeatureDefinitions)[number];
export type RecordsTableFeatureKey = Definition["key"];

const registry = Object.fromEntries(
  recordsTableFeatureDefinitions.map((definition) => [definition.key, definition]),
) as Readonly<Record<RecordsTableFeatureKey, RecordsTableFeatureDefinition<object>>>;

/** The feature keys in the order Studio lists them; each is a key of the `features` setting group. */
export const recordsTableFeatureKeys: readonly RecordsTableFeatureKey[] = [
  recordsTableSpreadsheetFeature,
  recordsTablePinningFeature,
  recordsTableSearchFeature,
  recordsTableColumnFiltersFeature,
  recordsTableSavedViewsFeature,
  recordsTableBulkActionsFeature,
  recordsTableInlineEditFeature,
  recordsTableRowEditFeature,
  recordsTableRowActionsFeature,
  recordsTableMasterDetailFeature,
  recordsTableTreeFeature,
  recordsTableGroupingFeature,
  recordsTableTotalsFeature,
  recordsTableConditionalFormattingFeature,
  recordsTablePivotFeature,
  recordsTableBoardFeature,
  recordsTableExportFeature,
].map((definition) => definition.key);

/** One feature's definition, for code that works through a feature by its key. */
export const recordsTableFeatureDefinition = (
  key: RecordsTableFeatureKey,
): RecordsTableFeatureDefinition<object> => registry[key];

/** The viewport's refusal: a page-scrolling table draws every row, so its page stays small. */
const boundedScrollingRefusal: GridFeatureRefusal = {
  code: "definition_records_table_bounded_scrolling",
  order: 35,
  message: "A Records table page of more than 100 rows needs bounded scrolling.",
  guidance: "Set the table's Scrolling to Bounded, or choose a page size of 100 rows or fewer.",
};

/** A feature's business name and one-line description, for Studio's Features list. */
export const recordsTableFeatureDescription = (
  key: RecordsTableFeatureKey,
): Readonly<{ label: string; description: string }> => ({
  label: registry[key].label,
  description: registry[key].description,
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
    const read = <Key extends RecordsTableFeatureKey>(
      key: Key,
    ): RecordsTableFeatureState<object> => {
      const feature = requiredGroup(group[key], `features.${key}`);
      return withSettingPath(`features.${key}`, () => registry[key].read(feature));
    };
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
 * Whether the table must be grouped to read its query: a grouped query has no flat rows, so a
 * table that reads one (and is not a board, which reads it its own way) shows its records in
 * groups. Publication refuses such a table while Group by is off, even though the feature is off.
 */
export const recordsTableGroupingRequired = (
  features: RecordsTableFeatures,
  facts: RecordsTableQueryFacts,
): boolean => facts.grouped && !features.board.enabled;

/** Every refusal of the grid features and the viewport, for the definition validation catalogue. */
export const recordsTableFeatureRefusals: readonly GridFeatureRefusal[] = [
  boundedScrollingRefusal,
  ...recordsTableFeatureDefinitions.flatMap((definition) => definition.refusals),
];

/**
 * The one capability check of one feature against the bound query's facts. Publication runs it on
 * the compiled release for every enabled feature and refuses with its sentence; Studio runs it on
 * the draft's facts beside each switch, so the two never disagree. Each definition decides its own
 * rules; this only orders them: the feature's conflicts with the table and its other features, then
 * the board (which refuses a feature it does not draw and judges one it borrows), then the query.
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
      ? featureNotPossible(boundedScrollingRefusal)
      : featureAvailable;
  const definition = registry[key];
  const assessed = (() => {
    const context = { features, presentation, tablePageSize };
    const conflict = definition.conflicts?.(state, facts, context);
    if (conflict !== undefined) return conflict;
    if (features.board.enabled && definition.onBoard === "unsupported")
      return state.enabled
        ? featureNotPossible(
            definition.refusals[0],
            `${definition.label} is not available on a board yet: turn Board off to use it, or turn ${definition.label} off.`,
          )
        : definition.check(state, facts, context);
    // The board reads its own grouped query, which the board check judges; a table-row check of a
    // feature the board borrows would refuse that query.
    if (features.board.enabled && definition.onBoard === "supported")
      return facts.board === undefined
        ? featureAvailable
        : (definition.boardCheck?.(state, facts.board) ?? featureAvailable);
    return definition.check(state, facts, context);
  })();
  // Each refusal names its feature once, whether or not its own sentence already starts with it.
  return assessed.kind === "available" || assessed.reason.startsWith(definition.label)
    ? assessed
    : {
        ...assessed,
        reason: `${definition.label}: ${assessed.reason}`,
      };
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
> = Object.fromEntries(
  recordsTableFeatureDefinitions.flatMap((definition) =>
    Object.entries(definition.events ?? {}).map(([event, offer]) => [
      event,
      { feature: definition.key, ...offer },
    ]),
  ),
);

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

export { recordsTableInlineEditEvent } from "./inline-edit";

export { recordsTableRowEditEvent } from "./row-edit";
