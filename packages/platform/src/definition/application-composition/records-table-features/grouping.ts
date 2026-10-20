import {
  factsOf,
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  settingField,
  settingText,
  type RecordsTableFeatureDefinition,
  type RecordsTableFieldFacts,
} from "./shared";

/** The most choices a grouping field may hold: every group is one summary row and one header. */
export const RECORDS_TABLE_GROUPING_MAXIMUM_CHOICES = 50;
/** The longest name the group of records with no value may carry. */
export const RECORDS_TABLE_GROUPING_MAXIMUM_LABEL_LENGTH = 40;

/**
 * Group by: the viewer may group the table by one choice field, a stage being a choice field with a
 * pipeline. `field` is that field, a column of the bound query people can filter by, and
 * `unassignedLabel` names the group of records with no value (or whose value the viewer cannot
 * see). Each part is absent until the builder names it, which the check refuses.
 */
export type RecordsTableGroupingSettings = Readonly<{
  field?: string;
  unassignedLabel?: string;
}>;

const code = "definition_records_table_grouping" as const;

/** Whether a field can be grouped by at all; a choice field is also bounded by its options. */
const groupable = (field: RecordsTableFieldFacts): boolean =>
  field.type === "choice" && field.filterable;

export const recordsTableGroupingFeature: RecordsTableFeatureDefinition<RecordsTableGroupingSettings> =
  {
    key: "grouping",
    label: "Group by",
    description: "Group the records by a choice or stage field, counted on the server",
    read: (group) => {
      if (featureEnabled(group) !== true) return { enabled: false };
      const field = settingField(group["field"]);
      const unassignedLabel = settingText(group["unassigned_label"]);
      return {
        enabled: true,
        ...(field === undefined ? {} : { field }),
        ...(unassignedLabel === undefined ? {} : { unassignedLabel }),
      };
    },
    // Grouping needs a choice (or stage) field the query selects and people can filter by, with
    // few enough choices to count each one. Every refusal names the part that does not fit.
    check: (state, facts) => {
      if (facts.grouped)
        return featureNotPossible(code, "Rows that total records cannot be grouped again.");
      if (!facts.fields.some(groupable))
        return featureNotPossible(
          code,
          "Group by needs a choice or stage field in the bound query",
        );
      if (!state.enabled) return featureAvailable;
      if (state.field === undefined)
        return featureNotPossible(code, "Choose the choice or stage field to group by.");
      const field = factsOf(facts, state.field);
      if (field === undefined) {
        const unselected = facts.unselectedFields?.find(
          (candidate) => candidate.field.toLowerCase() === state.field!.toLowerCase(),
        );
        return featureNotPossible(
          code,
          `${unselected?.label ?? "The chosen field"} is not selected by the query`,
        );
      }
      if (field.type !== "choice")
        return featureNotPossible(code, `${field.label} is not a choice or stage field`);
      if (!field.filterable)
        return featureNotPossible(
          code,
          `${field.label} cannot be grouped by until it is filterable: make it filterable in Data.`,
        );
      if (
        field.choiceCount === undefined ||
        field.choiceCount < 1 ||
        field.choiceCount > RECORDS_TABLE_GROUPING_MAXIMUM_CHOICES
      )
        return featureNotPossible(
          code,
          `${field.label} has more than ${RECORDS_TABLE_GROUPING_MAXIMUM_CHOICES} choices; group by a field with fewer`,
        );
      if (state.unassignedLabel === undefined)
        return featureNotPossible(code, "Name the group of records that have no value.");
      if (state.unassignedLabel.length > RECORDS_TABLE_GROUPING_MAXIMUM_LABEL_LENGTH)
        return featureNotPossible(
          code,
          `Name the group of records with no value in at most ${RECORDS_TABLE_GROUPING_MAXIMUM_LABEL_LENGTH} characters.`,
        );
      return featureAvailable;
    },
  };
