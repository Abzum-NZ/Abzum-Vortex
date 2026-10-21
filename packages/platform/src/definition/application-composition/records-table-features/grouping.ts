import {
  factsOf,
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  optionalChoice,
  optionalField,
  optionalNumber,
  optionalText,
  recordsTablePivotDateUnits,
  requiredBoolean,
  type RecordsTableFeatureCheck,
  type RecordsTableFeatureDefinition,
  type RecordsTableFeatureState,
  type RecordsTableFieldFacts,
  type RecordsTablePivotDateUnit,
  type RecordsTableQueryFacts,
} from "./shared";

/** The most choices a grouping field may hold: every group is one summary row and one header. */
export const RECORDS_TABLE_GROUPING_MAXIMUM_CHOICES = 50;
/** The longest name the group of records with no value may carry. */
export const RECORDS_TABLE_GROUPING_MAXIMUM_LABEL_LENGTH = 40;
/** The most groups one page of a grouped table may show; more groups continue on the next page. */
export const RECORDS_TABLE_GROUPING_MAXIMUM_PAGE_SIZE = 200;

/** The field types a table may be grouped by: a link is grouped by its target, a date by a calendar unit. */
export const recordsTableGroupingFieldTypes = ["choice", "link", "date", "date_time"] as const;
export type RecordsTableGroupingFieldType = (typeof recordsTableGroupingFieldTypes)[number];

/**
 * Group by: the viewer may group the table by one choice, link or date field, a stage being a
 * choice field with a pipeline. `field` is that field, a column of the bound query people can
 * filter by; a date field needs its calendar unit (`dateUnit`, bucketed in the organisation's time
 * zone); `groupPageSize` is how many groups one page shows; `unassignedLabel` names the group of
 * records with no value (or whose value the viewer cannot see); `opensGrouped` is whether the
 * table opens grouped (the viewer's address may then ungroup it) or flat (the viewer's address may
 * then group it). Each part is absent until the builder names it, which the check refuses.
 */
export type RecordsTableGroupingSettings = Readonly<{
  field?: string;
  dateUnit?: RecordsTablePivotDateUnit;
  groupPageSize?: number;
  unassignedLabel?: string;
  opensGrouped?: boolean;
}>;

const code = "definition_records_table_grouping" as const;

/** Whether a field can be grouped by at all; a choice field is also bounded by its options. */
const groupable = (field: RecordsTableFieldFacts): boolean =>
  (recordsTableGroupingFieldTypes as readonly string[]).includes(field.type) && field.filterable;

/**
 * A table that reads a grouped query has no flat rows to show: it is a Grouped table, so Group by
 * and Open grouped must be on. Publication and Studio refuse the table until they are.
 */
export const recordsTableGroupedQueryRefusal = (
  facts: Pick<RecordsTableQueryFacts, "queryLabel">,
): RecordsTableFeatureCheck =>
  featureNotPossible(
    code,
    `A table that reads ${facts.queryLabel || "this query"} shows its records in groups: switch on Group by and Open grouped.`,
  );

/**
 * What a Grouped table starts with when its query already groups: the first field the query groups
 * by, and for a date field the calendar unit it starts with. Studio writes these once, when the
 * builder switches Group by on or adds a Grouped table; nothing reads them back at run time.
 * Undefined when the query groups by no field the table can group by.
 */
export const groupingDefaultsFromQuery = (
  facts: Pick<RecordsTableQueryFacts, "fields" | "groupBy">,
): Readonly<{ field: string; dateUnit?: RecordsTablePivotDateUnit }> | undefined => {
  const first = facts.groupBy[0];
  const field = first === undefined ? undefined : factsOf(facts, first);
  if (field === undefined || !groupable(field)) return undefined;
  return {
    field: field.field,
    ...(field.type === "date" || field.type === "date_time" ? { dateUnit: "month" as const } : {}),
  };
};

/** What the grouping check reads of the bound query: Studio's Grouped table preset judges the same facts. */
export type RecordsTableGroupingFacts = Pick<
  RecordsTableQueryFacts,
  "recordTypeLabel" | "fields" | "unselectedFields" | "grouped" | "queryLabel"
>;

/**
 * Grouping needs a choice (or stage), link or date field the query selects and people can filter
 * by; a choice field has few enough choices to count each one, a date field a calendar unit, and
 * every group page a size. Every refusal names the part that does not fit.
 */
export const checkRecordsTableGrouping = (
  state: RecordsTableFeatureState<RecordsTableGroupingSettings>,
  facts: RecordsTableGroupingFacts,
): RecordsTableFeatureCheck => {
  if (!facts.fields.some(groupable))
    return featureNotPossible(
      code,
      "Group by needs a choice, stage, link or date field in the bound query",
    );
  if (!state.enabled) return featureAvailable;
  const recordType = facts.recordTypeLabel || "this record type";
  if (state.field === undefined)
    return featureNotPossible(code, "Choose the choice, stage, link or date field to group by.");
  const field = factsOf(facts, state.field);
  if (field === undefined) {
    const unselected = facts.unselectedFields?.find(
      (candidate) => candidate.field.toLowerCase() === state.field!.toLowerCase(),
    );
    return featureNotPossible(
      code,
      `Grouping by ${unselected?.label ?? "the chosen field"} needs a choice, stage, link or date field of ${recordType} that the query reads`,
    );
  }
  if (!(recordsTableGroupingFieldTypes as readonly string[]).includes(field.type))
    return featureNotPossible(
      code,
      `Grouping by ${field.label} needs a choice, stage, link or date field of ${recordType} that the query reads`,
    );
  if (!field.filterable)
    return featureNotPossible(
      code,
      `${field.label} cannot be grouped by until it is filterable: make it filterable in Data.`,
    );
  if (
    field.type === "choice" &&
    (field.choiceCount === undefined ||
      field.choiceCount < 1 ||
      field.choiceCount > RECORDS_TABLE_GROUPING_MAXIMUM_CHOICES)
  )
    return featureNotPossible(
      code,
      `${field.label} has more than ${RECORDS_TABLE_GROUPING_MAXIMUM_CHOICES} choices; group by a field with fewer`,
    );
  if ((field.type === "date" || field.type === "date_time") && state.dateUnit === undefined)
    return featureNotPossible(
      code,
      `Choose how to group ${field.label}: by day, week, month, quarter or year`,
    );
  if (
    state.groupPageSize === undefined ||
    !Number.isInteger(state.groupPageSize) ||
    state.groupPageSize < 1 ||
    state.groupPageSize > RECORDS_TABLE_GROUPING_MAXIMUM_PAGE_SIZE
  )
    return featureNotPossible(
      code,
      `Set a group page of at most ${RECORDS_TABLE_GROUPING_MAXIMUM_PAGE_SIZE}`,
    );
  if (state.opensGrouped === undefined)
    return featureNotPossible(code, "Choose whether the table opens grouped.");
  // A table that reads a grouped query has no flat rows, so it can only open grouped.
  if (facts.grouped && !state.opensGrouped) return recordsTableGroupedQueryRefusal(facts);
  if (state.unassignedLabel === undefined)
    return featureNotPossible(code, "Name the group of records that have no value.");
  if (state.unassignedLabel.length > RECORDS_TABLE_GROUPING_MAXIMUM_LABEL_LENGTH)
    return featureNotPossible(
      code,
      `Name the group of records with no value in at most ${RECORDS_TABLE_GROUPING_MAXIMUM_LABEL_LENGTH} characters.`,
    );
  return featureAvailable;
};

export const recordsTableGroupingFeature: RecordsTableFeatureDefinition<RecordsTableGroupingSettings> =
  {
    key: "grouping",
    label: "Group by",
    description: "Group the records by a choice, stage, link or date field, counted on the server",
    read: (group) => {
      if (!featureEnabled(group)) return { enabled: false };
      const field = optionalField(group["field"], "field");
      const unassignedLabel = optionalText(group["unassigned_label"], "unassigned_label");
      const dateUnit = optionalChoice(group["date_unit"], recordsTablePivotDateUnits, "date_unit");
      const groupPageSize = optionalNumber(group["group_page_size"], "group_page_size");
      return {
        enabled: true,
        ...(field === undefined ? {} : { field }),
        ...(dateUnit === undefined ? {} : { dateUnit }),
        ...(groupPageSize === undefined ? {} : { groupPageSize }),
        ...(unassignedLabel === undefined ? {} : { unassignedLabel }),
        opensGrouped: requiredBoolean(group["opens_grouped"], "opens_grouped"),
      };
    },
    check: checkRecordsTableGrouping,
  };
