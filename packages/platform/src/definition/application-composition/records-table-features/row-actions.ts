import { namedActionAvailabilitySchema } from "../../../pages/named-action-availability-schema";
import { z } from "zod";
import type { RecordsTableFeatureProjection } from "../../../pages/records-table-feature-projection";
import type { ComponentSettingValue } from "../block-property-schema";
import {
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  optionalChoice,
  requiredChoice,
  requiredGroup,
  requiredItems,
  requiredText,
  unreadable,
  type RecordsTableFeatureDefinition,
  type RecordsTableFeatureState,
  type GridFeatureProjectionContext,
  type GridFeatureRefusal,
  type GridFeatureSettingsDeclaration,
} from "./shared";

/** Row declarations remain the table's single flow-binding list. The feature controls their use. */
/** The feature's setting group in the Table release, off by default. */
const featureSettings = {
  kind: "group",
  key: "row_actions",
  label: "Row actions",
  help: "Buttons and a menu that run each row's declared workflows",
  required: false,
  defaultValue: {
    kind: "group",
    properties: {
      enabled: {
        kind: "boolean",
        value: false,
      },
    },
  },
  properties: [
    {
      kind: "boolean",
      key: "enabled",
      label: "Enabled",
      help: "Offer the declared row actions",
      required: true,
      defaultValue: {
        kind: "boolean",
        value: false,
      },
    },
  ],
} as const satisfies GridFeatureSettingsDeclaration;

/** The feature's refusals and their business sentences. */
const featureRefusal: GridFeatureRefusal = {
  code: "definition_records_table_row_actions",
  order: 39,
  message: "Row actions need a query that returns individual records",
  guidance: "Choose a query that lists records rather than totals or groups.",
};
const rowActionLimitRefusal: GridFeatureRefusal = {
  code: "definition_records_table_row_action_limit",
  order: 39,
  message: "At most three actions can sit beside the row; move the rest to the menu",
  guidance: "Choose Row menu for the remaining actions.",
};

export const recordsTableRowActionIcons = [
  "workflow",
  "check",
  "close",
  "info",
  "minus",
  "eye",
  "plus",
  "undo",
] as const;

/** The record action kinds a configured row or bulk action may require of the viewer. */
export const recordsTableActionCapabilities = ["update", "delete", "restore"] as const;
type RecordsTableActionCapability = (typeof recordsTableActionCapabilities)[number];

const textSchema = z.string().min(1);
const rowActionSchema = z
  .object({
    eventId: textSchema,
    label: textSchema,
    icon: z.enum(recordsTableRowActionIcons),
    placement: z.enum(["inline", "menu"]),
    capability: z.enum(recordsTableActionCapabilities).optional(),
  })
  .strict()
  .readonly();

const projectionSchema = z
  .object({
    actions: z
      .array(rowActionSchema)
      .min(1)
      .max(20)
      .refine(
        (actions) => new Set(actions.map((action) => action.eventId)).size === actions.length,
        "Each row action is named once",
      )
      .readonly(),
    availability: namedActionAvailabilitySchema,
  })
  .strict()
  .readonly();

export const recordsTableRowActionsFeature: RecordsTableFeatureDefinition<object, "row_actions"> &
  Readonly<{ property: "rowActions"; projectionSchema: typeof projectionSchema }> = {
  key: "row_actions",
  property: "rowActions",
  projectionSchema,
  settings: featureSettings,
  refusals: [featureRefusal, rowActionLimitRefusal],
  onBoard: "supported",
  events: { row_action: {} },
  label: "Row actions",
  description: "Run a row's workflows from buttons and a menu",
  read: (group) => ({ enabled: featureEnabled(group) }),
  conflicts: (state, facts) =>
    state.enabled &&
    facts.table.rowActions.filter((action) => action.placement === "inline").length > 3
      ? featureNotPossible(rowActionLimitRefusal)
      : undefined,
  project: (state, context) =>
    recordsTableRowActionsProjection(state, context.rowBehaviours, context.rows),
  check: (_state, facts) =>
    facts.grouped || facts.maximumPageSize === undefined
      ? featureNotPossible(
          featureRefusal,
          "Row actions need a query that returns individual records",
        )
      : featureAvailable,
};

/**
 * One row action bound to a workflow. `eventId` is the stable identity of the flow binding the
 * command runs; it is unique across one placement's declared behaviours, so a click reaches
 * exactly one flow. `capability`, when declared, names the record action the command needs: the
 * server disables it for a row whose per-row capabilities do not include that kind. A workflow that
 * declares no capability (an open, read or custom command) stays offered, and the server still
 * re-checks every action it runs.
 */
export type RecordsTableActionContract = Readonly<{
  eventId: string;
  label: string;
  capability?: RecordsTableActionCapability | undefined;
  icon: (typeof recordsTableRowActionIcons)[number];
  placement: "inline" | "menu";
}>;

/** Reads the whole declaration or refuses it; a partial entry must never disappear on publish. */
export const readRecordsTableRowActions = (
  value: ComponentSettingValue | undefined,
): RecordsTableActionContract[] => {
  const actions: RecordsTableActionContract[] = [];
  for (const [index, item] of requiredItems(value, "row_actions").entries()) {
    const at = `row_actions[${index}]`;
    const action = requiredGroup(item, at);
    const eventId = requiredText(action["event_id"], `${at}.event_id`);
    if (actions.some((entry) => entry.eventId.toLowerCase() === eventId.toLowerCase()))
      return unreadable(`${at}.event_id`);
    const capability = optionalChoice(
      action["capability"],
      recordsTableActionCapabilities,
      `${at}.capability`,
    );
    actions.push({
      eventId,
      label: requiredText(action["label"], `${at}.label`),
      icon: requiredChoice(action["icon"], recordsTableRowActionIcons, `${at}.icon`),
      placement: requiredChoice(
        action["placement"],
        ["inline", "menu"] as const,
        `${at}.placement`,
      ),
      ...(capability === undefined ? {} : { capability }),
    });
  }
  return actions;
};

/**
 * The row actions a table offers and, per row, whether the capabilities its read decided make each
 * eligible; absent when the feature is off or the table declares none. Named-action eligibility is
 * decided afterwards, in the read's own request, by `projectRowActionAvailability`.
 */
export const recordsTableRowActionsProjection = (
  state: RecordsTableFeatureState<object>,
  rowBehaviours: GridFeatureProjectionContext["rowBehaviours"],
  rows: GridFeatureProjectionContext["rows"],
): RecordsTableFeatureProjection["rowActions"] =>
  state.enabled && rowBehaviours.rowActions.length > 0
    ? {
        actions: rowBehaviours.rowActions,
        availability: rows.flatMap((row) =>
          row.revision === undefined
            ? []
            : [
                {
                  recordId: row.recordId,
                  revision: row.revision,
                  actions: rowBehaviours.rowActions.map((action) =>
                    action.capability === undefined ||
                    row.capabilities?.actions.includes(action.capability) === true
                      ? { action: action.eventId, eligible: true as const }
                      : {
                          action: action.eventId,
                          eligible: false as const,
                          reason: "not_permitted" as const,
                        },
                  ),
                },
              ],
        ),
      }
    : undefined;
