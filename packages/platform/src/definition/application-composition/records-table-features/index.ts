import type { ComponentSettingValue } from "../block-property-schema";
import {
  recordsTableBulkActionsFeature,
  type RecordsTableBulkActionsSettings,
} from "./bulk-actions";
import {
  recordsTableColumnFiltersFeature,
  type RecordsTableColumnFiltersSettings,
} from "./column-filters";
import { recordsTableInlineEditFeature, type RecordsTableInlineEditSettings } from "./inline-edit";
import {
  recordsTableConditionalFormattingFeature,
  type RecordsTableConditionalFormattingSettings,
} from "./conditional-formatting";
import { recordsTableSavedViewsFeature, type RecordsTableSavedViewsSettings } from "./saved-views";
import { recordsTableSearchFeature, type RecordsTableSearchSettings } from "./search";
import { recordsTablePinningFeature, type RecordsTablePinningSettings } from "./pinning";
import {
  settingGroup,
  type RecordsTableFeatureCheck,
  type RecordsTableFeatureDefinition,
  type RecordsTableFeatureState,
  type RecordsTableQueryFacts,
} from "./shared";

export {
  factsValueType,
  recordsTableActionCapabilities,
  recordsTableEditableFieldTypes,
  type RecordsTableActionCapability,
  type RecordsTableActionContract,
  type RecordsTableFeatureCheck,
  type RecordsTableFeatureRefusalCode,
  type RecordsTableFeatureState,
  type RecordsTableFieldFacts,
  type RecordsTableQueryFacts,
} from "./shared";
export {
  conditionalColumnFormatFieldTypes,
  conditionalColumnFormatIssue,
  conditionalFormatComparisons,
  conditionalFormatIcons,
  conditionalFormatRuleFields,
  conditionalFormatRuleIssue,
  conditionalFormatTokens,
  conditionalFormattingDateParameters,
  type ConditionalColumnFormat,
  type ConditionalFormatComparison,
  type ConditionalFormatCondition,
  type ConditionalFormatIcon,
  type ConditionalFormatOperand,
  type ConditionalFormatRule,
  type ConditionalFormatStyle,
  type ConditionalFormatToken,
  type ConditionalFormattingDateParameter,
} from "./conditional-formatting";
export type {
  RecordsTableConditionalFormattingSettings,
  RecordsTableBulkActionsSettings,
  RecordsTableColumnFiltersSettings,
  RecordsTableInlineEditSettings,
  RecordsTableSavedViewsSettings,
  RecordsTableSearchSettings,
  RecordsTablePinningSettings,
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
  conditionalFormatting: RecordsTableFeatureState<RecordsTableConditionalFormattingSettings>;
  pinning: RecordsTableFeatureState<RecordsTablePinningSettings>;
}>;

const registry = {
  pinning: { property: "pinning", definition: recordsTablePinningFeature },
  search: { property: "search", definition: recordsTableSearchFeature },
  column_filters: { property: "columnFilters", definition: recordsTableColumnFiltersFeature },
  saved_views: { property: "savedViews", definition: recordsTableSavedViewsFeature },
  bulk_actions: { property: "bulkActions", definition: recordsTableBulkActionsFeature },
  inline_edit: { property: "inlineEdit", definition: recordsTableInlineEditFeature },
  conditional_formatting: {
    property: "conditionalFormatting",
    definition: recordsTableConditionalFormattingFeature,
  },
} as const satisfies Record<
  string,
  Readonly<{
    property: keyof RecordsTableFeatures;
    definition: RecordsTableFeatureDefinition<object>;
  }>
>;

/** The feature keys in the order Studio lists them; each is a key of the `features` setting group. */
export const recordsTableFeatureKeys = [
  "pinning",
  "search",
  "column_filters",
  "saved_views",
  "bulk_actions",
  "inline_edit",
  "conditional_formatting",
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

/**
 * Reads the `features` setting group. The catalogue default fills in every feature, so a group
 * that is missing, or a feature that does not say whether it is on, is not read: no renderer or
 * server ever guesses a feature the definition did not decide.
 */
export const readRecordsTableFeatures = (
  value: ComponentSettingValue | undefined,
): RecordsTableFeatures | undefined => {
  const group = settingGroup(value);
  if (group === undefined) return undefined;
  const read = <Key extends RecordsTableFeatureKey>(key: Key) => {
    const feature = settingGroup(group[key]);
    return feature === undefined || feature["enabled"]?.kind !== "boolean"
      ? undefined
      : registry[key].definition.read(feature);
  };
  const search = read("search");
  const columnFilters = read("column_filters");
  const savedViews = read("saved_views");
  const bulkActions = read("bulk_actions");
  const inlineEdit = read("inline_edit");
  const conditionalFormatting = read("conditional_formatting");
  const pinning = read("pinning");
  if (
    search === undefined ||
    columnFilters === undefined ||
    savedViews === undefined ||
    bulkActions === undefined ||
    inlineEdit === undefined ||
    conditionalFormatting === undefined ||
    pinning === undefined
  )
    return undefined;
  return {
    search,
    pinning,
    columnFilters: columnFilters as RecordsTableFeatures["columnFilters"],
    savedViews,
    bulkActions: bulkActions as RecordsTableFeatures["bulkActions"],
    inlineEdit: inlineEdit as RecordsTableFeatures["inlineEdit"],
    conditionalFormatting: conditionalFormatting as RecordsTableFeatures["conditionalFormatting"],
  };
};

/**
 * The one capability check of one feature against the bound query's facts. Publication runs it on
 * the compiled release for every enabled feature and refuses with its sentence; Studio runs it on
 * the draft's facts beside each switch, so the two never disagree.
 */
export const checkRecordsTableFeature = (
  key: RecordsTableFeatureKey,
  state: RecordsTableFeatureState<object>,
  facts: RecordsTableQueryFacts,
): RecordsTableFeatureCheck =>
  (registry[key].definition as RecordsTableFeatureDefinition<object>).check(state, facts);

/** Every feature's state and check, in Studio's order. */
export const checkRecordsTableFeatures = (
  features: RecordsTableFeatures,
  facts: RecordsTableQueryFacts,
): readonly Readonly<{
  key: RecordsTableFeatureKey;
  enabled: boolean;
  check: RecordsTableFeatureCheck;
}>[] =>
  recordsTableFeatureKeys.map((key) => {
    const state = recordsTableFeatureState(features, key);
    return { key, enabled: state.enabled, check: checkRecordsTableFeature(key, state, facts) };
  });

const featureEvents: Readonly<Record<string, RecordsTableFeatureKey>> = {
  search_changed: "search",
  filter_changed: "column_filters",
  bulk_action: "bulk_actions",
  inline_edit: "inline_edit",
};

/** The feature whose controls raise this Records table event, for the events a feature owns. */
export const recordsTableFeatureOfEvent = (event: string): RecordsTableFeatureKey | undefined =>
  Object.hasOwn(featureEvents, event) ? featureEvents[event] : undefined;

/**
 * Whether an authored placement's plain `features` setting turns a feature on. The catalogue
 * default leaves every feature off, so a placement that sets no features has none on.
 */
export const authoredRecordsTableFeatureEnabled = (
  props: Readonly<Record<string, unknown>>,
  key: RecordsTableFeatureKey,
): boolean => {
  const features = props["features"];
  if (features === null || typeof features !== "object") return false;
  const feature = (features as Record<string, unknown>)[key];
  return (
    feature !== null &&
    typeof feature === "object" &&
    (feature as Record<string, unknown>)["enabled"] === true
  );
};
