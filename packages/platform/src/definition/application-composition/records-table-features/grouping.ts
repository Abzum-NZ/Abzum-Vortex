import {
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  settingField,
  settingOptionalChoice,
  settingText,
  type RecordsTableFeatureDefinition,
  type RecordsTableFieldFacts,
} from "./shared";

export const recordsTableDateGroupUnits = ["day", "week", "month", "quarter", "year"] as const;
export type RecordsTableDateGroupUnit = (typeof recordsTableDateGroupUnits)[number];
export type RecordsTableGroupingSettings = Readonly<{
  field?: string;
  limit?: number;
  unit?: RecordsTableDateGroupUnit;
  timeZone?: string;
}>;

export const recordsTableFieldGroupable = (field: RecordsTableFieldFacts): boolean =>
  field.filterable &&
  (field.type === "date" ||
    field.type === "date_time" ||
    (field.type === "choice" &&
      field.choiceCount !== undefined &&
      field.choiceCount >= 1 &&
      field.choiceCount <= 50));

export const recordsTableGroupingFeature: RecordsTableFeatureDefinition<RecordsTableGroupingSettings> = {
  key: "grouping",
  label: "Grouping",
  description: "Show counted choice or calendar groups; read records only when a group opens",
  read: (group) => {
    if (!featureEnabled(group)) return { enabled: false };
    const field = settingField(group["field"]);
    const limit = group["limit"];
    const unit = settingOptionalChoice(group["unit"], recordsTableDateGroupUnits);
    const timeZone = settingText(group["time_zone"]);
    return {
      enabled: true,
      ...(field === undefined ? {} : { field }),
      ...(limit?.kind !== "number" ? {} : { limit: limit.value }),
      ...(unit === undefined ? {} : { unit }),
      ...(timeZone === undefined ? {} : { timeZone }),
    };
  },
  check: (state, facts) => {
    const no = (reason: string) => featureNotPossible("definition_records_table_grouping", reason);
    if (!state.enabled)
      return facts.fields.some(recordsTableFieldGroupable)
        ? featureAvailable
        : no("Grouping needs a filterable choice with up to 50 options, or a date field in this query.");
    const field = facts.fields.find((candidate) => candidate.field.toLowerCase() === state.field?.toLowerCase());
    if (field === undefined || !recordsTableFieldGroupable(field))
      return no("Choose a filterable choice with up to 50 options, or a date field from this query.");
    if (state.limit === undefined || !Number.isInteger(state.limit) || state.limit < 1 || state.limit > 200)
      return no("Show between 1 and 200 groups at a time.");
    if (field.type === "date" || field.type === "date_time") {
      if (state.unit === undefined) return no("Choose a calendar unit for date groups.");
      try {
        if (state.timeZone === undefined || /^[+-]/.test(state.timeZone)) throw new Error("zone");
        new Intl.DateTimeFormat("en", { timeZone: state.timeZone });
      } catch {
        return no("Choose a recognised named time zone for date groups.");
      }
    }
    return featureAvailable;
  },
};
