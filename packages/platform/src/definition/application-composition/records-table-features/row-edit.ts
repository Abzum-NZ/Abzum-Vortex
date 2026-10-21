import {
  factsOf,
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  optionalChoice,
  optionalText,
  recordsTableDependencyMissing,
  recordsTableFieldNotEditableReason,
  requiredFieldList,
  type RecordsTableFeatureDefinition,
} from "./shared";

export type RecordsTableRowEditSettings = Readonly<{
  eventId?: string;
  fields: readonly string[];
  trigger?: "button";
}>;

const code = "definition_records_table_row_edit";

export const recordsTableRowEditFeature: RecordsTableFeatureDefinition<RecordsTableRowEditSettings> =
  {
    key: "row_edit",
    label: "Row editing",
    description: "Change a row's fields and save them together",
    read: (group) => {
      if (!featureEnabled(group)) return { enabled: false };
      const eventId = optionalText(group["event_id"], "event_id");
      const trigger = optionalChoice(group["trigger"], ["button"], "trigger");
      return {
        enabled: true,
        ...(eventId === undefined ? {} : { eventId }),
        fields: requiredFieldList(group["fields"], "fields"),
        ...(trigger === undefined ? {} : { trigger }),
      };
    },
    check: (state, facts) => {
      if (facts.grouped || !facts.fields.some((field) => field.editable))
        return featureNotPossible(
          code,
          `Row editing needs at least one stored field of ${facts.recordTypeLabel || "the record type"} that people may change`,
        );
      if (!state.enabled) return featureAvailable;
      if (state.eventId === undefined)
        return featureNotPossible(code, "Name the action that saves the row");
      if (state.trigger !== "button")
        return featureNotPossible(code, "Choose the button that starts editing a row");
      if (state.fields.length === 0)
        return featureNotPossible(code, "Choose the fields people may change together");
      if (new Set(state.fields.map((field) => field.toLowerCase())).size !== state.fields.length)
        return featureNotPossible(code, "Choose each editable field once");
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
