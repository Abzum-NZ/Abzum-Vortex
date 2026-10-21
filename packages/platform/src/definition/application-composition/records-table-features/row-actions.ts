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
} from "./shared";

/** Row declarations remain the table's single flow-binding list. The feature controls their use. */
export const recordsTableRowActionsFeature: RecordsTableFeatureDefinition<object> = {
  key: "row_actions",
  label: "Row actions",
  description: "Run a row's workflows from buttons and a menu",
  read: (group) => ({ enabled: featureEnabled(group) }),
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
