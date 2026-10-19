import {
  factsOf,
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  fieldList,
  settingText,
  type RecordsTableFeatureDefinition,
} from "./shared";

/**
 * Inline editing: people change chosen fields in place; one flow binding (`eventId`) commits each
 * change. `eventId` is absent until the builder names it, which the check refuses.
 */
export type RecordsTableInlineEditSettings = Readonly<{
  eventId?: string;
  fields: readonly string[];
}>;

export const recordsTableInlineEditFeature: RecordsTableFeatureDefinition<RecordsTableInlineEditSettings> =
  {
    key: "inline_edit",
    label: "Inline editing",
    description: "Change chosen values in place",
    read: (group) => {
      if (featureEnabled(group) !== true) return { enabled: false };
      const eventId = settingText(group["event_id"]);
      return {
        enabled: true,
        ...(eventId === undefined ? {} : { eventId }),
        fields: fieldList(group["fields"]),
      };
    },
    // Every chosen field must be a stored value people may change; a grouped query has no records
    // to change.
    check: (state, facts) => {
      const editable = (field: string) => factsOf(facts, field)?.editable === true;
      const possible =
        !facts.grouped &&
        (state.enabled
          ? state.eventId !== undefined && state.fields.length > 0 && state.fields.every(editable)
          : facts.fields.some((field) => field.editable));
      return possible
        ? featureAvailable
        : featureNotPossible("definition_records_table_inline_edit");
    },
  };
