import { z } from "zod";
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
  type GridFeatureRefusal,
  type GridFeatureSettingsDeclaration,
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
    featureRefusal,
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
      featureRefusal,
      "Group by needs a choice, stage, link or date field in the bound query",
    );
  if (!state.enabled) return featureAvailable;
  const recordType = facts.recordTypeLabel || "this record type";
  if (state.field === undefined)
    return featureNotPossible(
      featureRefusal,
      "Choose the choice, stage, link or date field to group by.",
    );
  const field = factsOf(facts, state.field);
  if (field === undefined) {
    const unselected = facts.unselectedFields?.find(
      (candidate) => candidate.field.toLowerCase() === state.field!.toLowerCase(),
    );
    return featureNotPossible(
      featureRefusal,
      `Grouping by ${unselected?.label ?? "the chosen field"} needs a choice, stage, link or date field of ${recordType} that the query reads`,
    );
  }
  if (!(recordsTableGroupingFieldTypes as readonly string[]).includes(field.type))
    return featureNotPossible(
      featureRefusal,
      `Grouping by ${field.label} needs a choice, stage, link or date field of ${recordType} that the query reads`,
    );
  if (!field.filterable)
    return featureNotPossible(
      featureRefusal,
      `${field.label} cannot be grouped by until it is filterable: make it filterable in Data.`,
    );
  if (
    field.type === "choice" &&
    (field.choiceCount === undefined ||
      field.choiceCount < 1 ||
      field.choiceCount > RECORDS_TABLE_GROUPING_MAXIMUM_CHOICES)
  )
    return featureNotPossible(
      featureRefusal,
      `${field.label} has more than ${RECORDS_TABLE_GROUPING_MAXIMUM_CHOICES} choices; group by a field with fewer`,
    );
  if ((field.type === "date" || field.type === "date_time") && state.dateUnit === undefined)
    return featureNotPossible(
      featureRefusal,
      `Choose how to group ${field.label}: by day, week, month, quarter or year`,
    );
  if (
    state.groupPageSize === undefined ||
    !Number.isInteger(state.groupPageSize) ||
    state.groupPageSize < 1 ||
    state.groupPageSize > RECORDS_TABLE_GROUPING_MAXIMUM_PAGE_SIZE
  )
    return featureNotPossible(
      featureRefusal,
      `Set a group page of at most ${RECORDS_TABLE_GROUPING_MAXIMUM_PAGE_SIZE}`,
    );
  if (state.opensGrouped === undefined)
    return featureNotPossible(featureRefusal, "Choose whether the table opens grouped.");
  // A table that reads a grouped query has no flat rows, so it can only open grouped.
  if (facts.grouped && !state.opensGrouped) return recordsTableGroupedQueryRefusal(facts);
  if (state.unassignedLabel === undefined)
    return featureNotPossible(featureRefusal, "Name the group of records that have no value.");
  if (state.unassignedLabel.length > RECORDS_TABLE_GROUPING_MAXIMUM_LABEL_LENGTH)
    return featureNotPossible(
      featureRefusal,
      `Name the group of records with no value in at most ${RECORDS_TABLE_GROUPING_MAXIMUM_LABEL_LENGTH} characters.`,
    );
  return featureAvailable;
};

/** The feature's setting group in the Table release, off by default. */
const featureSettings = {
  kind: "group",
  key: "grouping",
  label: "Group by",
  help: "Group the records by a choice, stage, link or date field, counted on the server",
  required: false,
  defaultValue: {
    kind: "group",
    properties: {
      enabled: {
        kind: "boolean",
        value: false,
      },
      opens_grouped: {
        kind: "boolean",
        value: false,
      },
    },
  },
  properties: [
    {
      kind: "boolean",
      key: "enabled",
      label: "On",
      help: "Let people group the table by the chosen field",
      required: false,
      defaultValue: {
        kind: "boolean",
        value: false,
      },
    },
    {
      kind: "field_reference",
      key: "field",
      label: "Group by",
      help: "A choice, stage, link or date field people can filter by; a choice field has at most 50 choices",
      required: false,
      fieldTypes: ["choice", "link", "date", "date_time"],
    },
    {
      kind: "text",
      key: "unassigned_label",
      label: "Name for records with no value",
      help: "Shown on the group of records that have no value, or whose value the viewer cannot see",
      required: false,
      minLength: 1,
      maxLength: 40,
    },
    {
      kind: "choice",
      key: "date_unit",
      label: "Group dates by",
      help: "The calendar unit when the field is a date, counted in the organisation's time zone",
      required: false,
      options: [
        {
          key: "day",
          label: "Day",
        },
        {
          key: "week",
          label: "Week",
        },
        {
          key: "month",
          label: "Month",
        },
        {
          key: "quarter",
          label: "Quarter",
        },
        {
          key: "year",
          label: "Year",
        },
      ],
    },
    {
      kind: "number",
      key: "group_page_size",
      label: "Groups at a time",
      help: "How many groups one page shows, at most 200; more groups continue on the next page",
      required: false,
      integer: true,
      minimum: 1,
      maximum: 200,
    },
    {
      kind: "boolean",
      key: "opens_grouped",
      label: "Open grouped",
      help: "Show the table in groups when it opens; people can still ungroup it. Off shows the records flat until someone groups them",
      required: false,
      defaultValue: {
        kind: "boolean",
        value: false,
      },
    },
  ],
} as const satisfies GridFeatureSettingsDeclaration;

/** The feature's refusals and their business sentences. */
const featureRefusal: GridFeatureRefusal = {
  code: "definition_records_table_grouping",
  order: 39,
  message: "Group by needs a choice, stage, link or date field in the bound query.",
  guidance:
    "Choose the choice, stage, link or date field the records are grouped by, or turn Group by off.",
};

const textSchema = z.string().min(1);
const onlyTrue = z.literal(true);
const projectionSchema = z
  .object({
    fieldId: textSchema,
    label: textSchema,
    unassignedLabel: textSchema,
    /** The authored opening state: the address overrides it (grouped or flat) for this viewer. */
    opensGrouped: z.boolean(),
    /** The table reads a grouped query, so it is always grouped and offers no way to ungroup. */
    required: onlyTrue.optional(),
  })
  .strict()
  .readonly();

export const recordsTableGroupingFeature: RecordsTableFeatureDefinition<
  RecordsTableGroupingSettings,
  "grouping"
> &
  Readonly<{ property: "grouping"; projectionSchema: typeof projectionSchema }> = {
  key: "grouping",
  property: "grouping",
  projectionSchema,
  settings: featureSettings,
  refusals: [featureRefusal],
  onBoard: "own",
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
  // Grouping is offered only for a field the viewer is guaranteed to see on every record; a
  // withheld field is never grouped by, so no group ever stands for a value the viewer cannot read.
  project: (state, { readable, fieldLabels }) => {
    if (
      !state.enabled ||
      state.field === undefined ||
      state.unassignedLabel === undefined ||
      state.opensGrouped === undefined ||
      !readable(state.field)
    )
      return undefined;
    const label = fieldLabels?.[state.field.toLowerCase()] ?? "";
    return label === ""
      ? undefined
      : {
          fieldId: state.field.toLowerCase(),
          label,
          unassignedLabel: state.unassignedLabel,
          opensGrouped: state.opensGrouped,
        };
  },
  conflicts: (state, facts, { features }) => {
    // A grouped query has no flat rows, so a table that reads one (and is not a board, which reads
    // it its own way) shows its records in groups.
    if (!state.enabled && facts.grouped && !features.board.enabled)
      return recordsTableGroupedQueryRefusal(facts);
    // Groups, a board's columns, a tree's levels and a pivot's cells each arrange the records
    // their own way, so the table shows one of them at a time.
    if (!state.enabled) return undefined;
    const other = features.board.enabled
      ? "Board"
      : features.tree.enabled
        ? "Tree"
        : features.pivot.enabled
          ? "Pivot"
          : undefined;
    return other === undefined
      ? undefined
      : featureNotPossible(featureRefusal, `Turn ${other} off to group the records.`);
  },
  check: checkRecordsTableGrouping,
};
