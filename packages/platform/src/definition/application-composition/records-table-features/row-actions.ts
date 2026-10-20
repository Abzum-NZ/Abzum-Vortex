import type { ComponentSettingValue } from "../block-property-schema";
import {
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  settingGroup,
  settingItems,
  settingText,
  settingOptionalChoice,
  type RecordsTableFeatureDefinition,
} from "./shared";

/** Row declarations remain the table's single flow-binding list. The feature controls their use. */
export const recordsTableRowActionsFeature: RecordsTableFeatureDefinition<object> = {
  key: "row_actions",
  label: "Row actions",
  description: "Run a row's workflows from buttons and a menu",
  read: (group) => ({ enabled: featureEnabled(group) === true }),
  check: (_state, facts) =>
    facts.grouped || facts.maximumPageSize === undefined
      ? featureNotPossible(
          "definition_records_table_row_actions",
          "Row actions need a query that returns individual records",
        )
      : featureAvailable,
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
export type RecordsTableActionCapability = (typeof recordsTableActionCapabilities)[number];

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
  capability?: RecordsTableActionCapability;
  icon: (typeof recordsTableRowActionIcons)[number];
  placement: "inline" | "menu";
}>;

/** Reads the whole declaration or refuses it; a partial entry must never disappear on publish. */
export const readRecordsTableRowActions = (
  value: ComponentSettingValue | undefined,
): RecordsTableActionContract[] | undefined => {
  const items = settingItems(value);
  if (items === undefined) return undefined;
  const actions: RecordsTableActionContract[] = [];
  for (const item of items) {
    const action = settingGroup(item);
    if (action === undefined) return undefined;
    const eventId = settingText(action["event_id"]);
    const label = settingText(action["label"]);
    if (eventId === undefined || label === undefined) return undefined;
    const capability = settingOptionalChoice(action["capability"], recordsTableActionCapabilities);
    if (action["capability"] !== undefined && capability === undefined) return undefined;
    if (actions.some((entry) => entry.eventId.toLowerCase() === eventId.toLowerCase()))
      return undefined;
    const icon = settingOptionalChoice(action["icon"], recordsTableRowActionIcons);
    const placement = settingOptionalChoice(action["placement"], ["inline", "menu"]);
    if (icon === undefined || placement === undefined) return undefined;
    actions.push({
      eventId,
      label,
      icon,
      placement,
      ...(capability === undefined ? {} : { capability }),
    });
  }
  return actions;
};
