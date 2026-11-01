import type { RecordsTableFeatureProjection } from "../../../pages/records-table-feature-projection";
import {
  applicationActionCapabilities,
  applicationLinkTargets,
  type ApplicationActionCapability,
  type ApplicationLinkTarget,
} from "../../../catalogue/application-link";
import type { ComponentSettingValue } from "../block-property-schema";
import {
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  optionalChoice,
  optionalText,
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

/** The record action kinds a configured row or bulk action may require of the viewer. */
export const recordsTableActionCapabilities = ["update", "delete", "restore"] as const;
type RecordsTableActionCapability = (typeof recordsTableActionCapabilities)[number];

export const recordsTableRowActionIcons = [
  "workflow",
  "check",
  "close",
  "info",
  "minus",
  "eye",
  "plus",
  "undo",
  "pencil",
  "trash",
  "arrow-up",
] as const;

export const recordsTableRowActionsFeature: RecordsTableFeatureDefinition<object, "row_actions"> &
  Readonly<{ property: "rowActions" }> = {
  key: "row_actions",
  property: "rowActions",
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
 * One row action bound to a workflow or to a server-resolved link. `eventId` is the stable identity
 * of the flow binding the command runs; it is unique across one placement's declared behaviours, so
 * a click reaches exactly one flow. `link` names an internal application destination the server
 * resolves per row: the action is offered only where the resolver returns an address for the person.
 * `capability`, when declared, names the record action the command needs: the server disables it for
 * a row whose per-row capabilities do not include that kind. `applicationCapability`, when declared,
 * names what the action needs of the application its row is about: the server decides it once per
 * read from the application-surface capability read. A workflow that declares no capability (an
 * open, read or custom command) stays offered, and the server still re-checks every action it runs.
 */
export type RecordsTableActionContract = Readonly<{
  eventId?: string;
  link?: ApplicationLinkTarget;
  label: string;
  capability?: RecordsTableActionCapability | undefined;
  applicationCapability?: ApplicationActionCapability | undefined;
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
    const eventId = optionalText(action["event_id"], `${at}.event_id`);
    const link = optionalChoice(action["link"], applicationLinkTargets, `${at}.link`);
    if ((eventId === undefined) === (link === undefined)) return unreadable(`${at}.event_id`);
    const identity = eventId ?? `link:${link}`;
    if (
      actions.some(
        (entry) => (entry.eventId ?? `link:${entry.link}`).toLowerCase() === identity.toLowerCase(),
      )
    )
      return unreadable(`${at}.event_id`);
    const capability = optionalChoice(
      action["capability"],
      recordsTableActionCapabilities,
      `${at}.capability`,
    );
    const applicationCapability = optionalChoice(
      action["application_capability"],
      applicationActionCapabilities,
      `${at}.application_capability`,
    );
    actions.push({
      ...(eventId === undefined ? {} : { eventId }),
      ...(link === undefined ? {} : { link }),
      label: requiredText(action["label"], `${at}.label`),
      icon: requiredChoice(action["icon"], recordsTableRowActionIcons, `${at}.icon`),
      placement: requiredChoice(
        action["placement"],
        ["inline", "menu"] as const,
        `${at}.placement`,
      ),
      ...(capability === undefined ? {} : { capability }),
      ...(applicationCapability === undefined ? {} : { applicationCapability }),
    });
  }
  return actions;
};

/**
 * The stable identity a row action's availability decision is reported under: its flow binding's
 * event, or the link target it resolves to.
 */
export const rowActionIdentity = (action: {
  eventId?: string | undefined;
  link?: ApplicationLinkTarget | undefined;
}): string => action.eventId ?? `link:${action.link}`;

/**
 * The row actions a table offers and, per row, whether the capabilities its read decided make each
 * eligible; absent when the feature is off or the table declares none. A server-resolved link or an
 * application capability starts ineligible and the read's own request decides it per row. Named
 * action eligibility is decided afterwards, in the read's own request, by
 * `projectRowActionAvailability`.
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
                  actions: rowBehaviours.rowActions.map((action) => {
                    const identity = rowActionIdentity(action);
                    if (action.applicationCapability !== undefined || action.link !== undefined)
                      return {
                        action: identity,
                        eligible: false as const,
                        reason: "not_permitted" as const,
                      };
                    return action.capability === undefined ||
                      row.capabilities?.actions.includes(action.capability) === true
                      ? { action: identity, eligible: true as const }
                      : {
                          action: identity,
                          eligible: false as const,
                          reason: "not_permitted" as const,
                        };
                  }),
                },
              ],
        ),
      }
    : undefined;
