import {
  factsOf,
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  fieldList,
  recordsTableDependencyMissing,
  recordsTableFieldNotEditableReason,
  settingText,
  type RecordsTableFeatureDefinition,
} from "./shared";

/**
 * Inline editing: people change chosen fields in place; one flow binding (`eventId`) commits each
 * change. `eventId` is absent until the builder binds the action that saves a change, which the
 * check refuses.
 */
export type RecordsTableInlineEditSettings = Readonly<{
  eventId?: string;
  fields: readonly string[];
}>;

const code = "definition_records_table_inline_edit";

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
    // Every chosen field must be a stored value people may change, and a change needs the action
    // that saves it; a grouped query has no records to change.
    check: (state, facts) => {
      const needed = featureNotPossible(
        code,
        `Inline editing needs at least one stored field of ${facts.recordTypeLabel || "the record type"} that people may change`,
      );
      if (facts.grouped || !facts.fields.some((field) => field.editable)) return needed;
      if (!state.enabled) return featureAvailable;
      if (state.eventId === undefined)
        return featureNotPossible(code, "Name the action that saves a change");
      if (state.fields.length === 0)
        return featureNotPossible(code, "Choose the fields people may change in place");
      for (const chosen of state.fields) {
        const field = factsOf(facts, chosen);
        if (field === undefined)
          return featureNotPossible(code, "Choose editable fields of the table's own query");
        const reason = recordsTableFieldNotEditableReason(field);
        if (reason !== undefined) return featureNotPossible(code, reason);
      }
      const missing = recordsTableDependencyMissing(facts, state.fields);
      if (missing !== undefined) return featureNotPossible(code, missing);
      return featureAvailable;
    },
  };
