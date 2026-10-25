import { z } from "zod";
import type { ComponentSettingValue } from "../block-property-schema";
import {
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  requiredBoolean,
  requiredGroup,
  requiredItems,
  requiredNumber,
  requiredText,
  unreadable,
  type RecordsTableFeatureDefinition,
  type RecordsTableFeatureState,
  type GridFeatureRefusal,
  type GridFeatureSettingsDeclaration,
} from "./shared";

/** The maximum authored action limit; explicit selections also have a 200-record page cap. */
export const recordsTableBulkActionRecordLimit = 5_000;

/**
 * One bulk action: a named action of the bound record type that people run over the selected rows,
 * or over every record the table's query, filters and search match. `action` is the action's key
 * as the release names it; `confirm` asks before it runs, with the exact count; `maxRecords` caps a
 * run over either kind of selection.
 */
export type RecordsTableBulkActionContract = Readonly<{
  action: string;
  label: string;
  confirm: boolean;
  maxRecords: number;
}>;

/**
 * Bulk actions: people select rows on this page, or every matching record, and run one named action
 * over the selection. Turning it on is what makes rows selectable.
 */
export type RecordsTableBulkActionsSettings = Readonly<{
  actions: readonly RecordsTableBulkActionContract[];
}>;

/** The actions offered by this feature, shared by its projection and availability reads. */
export const recordsTableBulkActions = (
  state: RecordsTableFeatureState<RecordsTableBulkActionsSettings>,
): readonly RecordsTableBulkActionContract[] => (state.enabled ? state.actions : []);

const settingAction = (value: ComponentSettingValue | undefined, path: string): string => {
  if (value?.kind !== "action_reference") return unreadable(path);
  return "actionKey" in value ? String(value.actionKey) : String(value.action);
};

/** Reads the declared bulk actions; an entry that does not say everything refuses the feature. */
const readBulkActions = (
  value: ComponentSettingValue | undefined,
): RecordsTableBulkActionContract[] =>
  requiredItems(value, "actions").map((item, index): RecordsTableBulkActionContract => {
    const at = `actions[${index}]`;
    const entry = requiredGroup(item, at);
    return {
      action: settingAction(entry["action"], `${at}.action`),
      label: requiredText(entry["label"], `${at}.label`),
      confirm: requiredBoolean(entry["confirm"], `${at}.confirm`),
      maxRecords: requiredNumber(entry["max_records"], `${at}.max_records`),
    };
  });

const sameKey = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

/** The feature's setting group in the Table release, off by default. */
const featureSettings = {
  kind: "group",
  key: "bulk_actions",
  label: "Bulk actions",
  help: "Select rows, or every matching record, and run a named action over them",
  required: false,
  defaultValue: {
    kind: "group",
    properties: {
      enabled: {
        kind: "boolean",
        value: false,
      },
      actions: {
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
      help: "Let people select rows and run commands over them",
      required: false,
      defaultValue: {
        kind: "boolean",
        value: false,
      },
    },
    {
      kind: "list",
      key: "actions",
      label: "Bulk actions",
      help: "Named actions of the record type people run over the selection",
      required: false,
      minimumItems: 0,
      maximumItems: 20,
      item: {
        kind: "group",
        key: "bulk_action",
        label: "Bulk action",
        help: "One named action over the selection",
        required: true,
        properties: [
          {
            kind: "action_reference",
            key: "action",
            label: "Named action",
            help: "The named action of the record type that runs on each selected record",
            required: true,
          },
          {
            kind: "text",
            key: "label",
            presentation: true,
            label: "Label",
            help: "Text shown on the command",
            required: true,
            minLength: 1,
            maxLength: 60,
          },
          {
            kind: "boolean",
            key: "confirm",
            label: "Ask first",
            help: "Ask people to confirm, with the exact number of records, before it runs",
            required: true,
            defaultValue: {
              kind: "boolean",
              value: true,
            },
          },
          {
            kind: "number",
            key: "max_records",
            integer: true,
            label: "Most records",
            help: "The most records one run over every matching record may change, up to 5,000",
            required: true,
            minimum: 1,
            maximum: 5000,
            defaultValue: {
              kind: "number",
              value: 5000,
            },
          },
        ],
      },
      defaultValue: {
        kind: "list",
        items: [],
      },
    },
  ],
} as const satisfies GridFeatureSettingsDeclaration;

/** The feature's refusals and their business sentences. */
const featureRefusal: GridFeatureRefusal = {
  code: "definition_records_table_bulk_actions",
  order: 39,
  message: "Bulk actions need a named action of the record type that accepts several records.",
  guidance:
    "Add a named action of the bound record type that needs no input typed for one record, with a limit of at most 5,000 records, or turn Bulk actions off.",
};

const textSchema = z.string().min(1);
const bulkActionSchema = z
  .object({
    action: textSchema,
    label: textSchema,
    confirm: z.boolean(),
    maxRecords: z.number().int().min(1).max(recordsTableBulkActionRecordLimit),
  })
  .strict()
  .readonly();

const projectionSchema = z.array(bulkActionSchema).min(1).readonly();

export const recordsTableBulkActionsFeature: RecordsTableFeatureDefinition<
  RecordsTableBulkActionsSettings,
  "bulk_actions"
> &
  Readonly<{ property: "bulkActions"; projectionSchema: typeof projectionSchema }> = {
  key: "bulk_actions",
  property: "bulkActions",
  projectionSchema,
  settings: featureSettings,
  refusals: [featureRefusal],
  onBoard: "unsupported",
  label: "Bulk actions",
  description: "Select rows, or every matching record, and run a named action over them",
  read: (group) =>
    featureEnabled(group)
      ? { enabled: true, actions: readBulkActions(group["actions"]) }
      : { enabled: false },
  // A selection of records needs rows that are records (a grouped or summarised query has none)
  // and a named action of their record type that runs on several records, each on its own.
  project: (state) => {
    const actions = recordsTableBulkActions(state);
    return actions.length === 0 ? undefined : actions;
  },
  check: (state, facts) => {
    const offered = facts.actions.filter((action) => action.acceptsSelection);
    const needed = featureNotPossible(
      featureRefusal,
      `Bulk actions need a named action of ${facts.recordTypeLabel || "the record type"} that accepts several records`,
    );
    if (facts.grouped || (!state.enabled && offered.length === 0)) return needed;
    if (!state.enabled) return featureAvailable;
    if (state.actions.length === 0) return needed;
    if (state.actions.length > 20)
      return featureNotPossible(featureRefusal, "Choose at most 20 bulk actions");
    if (
      new Set(state.actions.map((action) => action.action.toLowerCase())).size !==
      state.actions.length
    )
      return featureNotPossible(featureRefusal, "Choose each bulk action once");
    for (const declared of state.actions) {
      const action = facts.actions.find((candidate) => sameKey(candidate.key, declared.action));
      if (action === undefined) return needed;
      if (!action.acceptsSelection)
        return featureNotPossible(
          featureRefusal,
          `${action.label} changes one record at a time, so it cannot run on a selection`,
        );
      if (
        !Number.isInteger(declared.maxRecords) ||
        declared.maxRecords < 1 ||
        declared.maxRecords > recordsTableBulkActionRecordLimit
      )
        return featureNotPossible(featureRefusal, "Set a limit of at most 5,000 records");
    }
    return featureAvailable;
  },
};
