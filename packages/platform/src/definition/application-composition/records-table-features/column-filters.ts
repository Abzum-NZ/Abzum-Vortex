import {
  factsOf,
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  fieldList,
  type RecordsTableFeatureCheck,
  type RecordsTableFeatureDefinition,
  type RecordsTableFieldFacts,
  type RecordsTableQueryFacts,
} from "./shared";

/**
 * The filter kinds: text contains, choice is one of the chosen values, number and money are an
 * inclusive range of exact decimals, date is an inclusive range of calendar days, link is one of
 * the chosen records and yes/no is equality.
 */
export const recordsTableFilterKinds = [
  "text",
  "choice",
  "number",
  "money",
  "date",
  "link",
  "yes_no",
] as const;
export type RecordsTableFilterKind = (typeof recordsTableFilterKinds)[number];

/**
 * The filter kind of a canonical field type, or undefined for a type no column filter takes
 * (calculations, totals, attachments, tables, formatted text and links to one of several types).
 */
export const recordsTableFilterKindOf = (type: string): RecordsTableFilterKind | undefined => {
  switch (type) {
    case "text":
    case "long_text":
    case "email_address":
    case "phone_number":
    case "web_address":
    case "reference_number":
      return "text";
    case "choice":
    case "several_choices":
      return "choice";
    case "whole_number":
    case "decimal_number":
      return "number";
    case "money":
      return "money";
    case "date":
    case "date_time":
      return "date";
    case "link":
      return "link";
    case "yes_no":
      return "yes_no";
    default:
      return undefined;
  }
};

/** Column filters: one typed filter control for each chosen field. */
export type RecordsTableColumnFiltersSettings = Readonly<{ fields: readonly string[] }>;

const CODE = "definition_records_table_column_filters";

/**
 * Whether people may filter by a field of the bound query: the record type allows filtering by it,
 * it is stored rather than calculated, and its canonical type takes a filter kind.
 */
export const recordsTableFieldFilterable = (field: RecordsTableFieldFacts): boolean =>
  field.filterable &&
  field.type !== "calculation" &&
  field.type !== "total" &&
  recordsTableFilterKindOf(field.type) !== undefined;

/** Why one chosen field cannot be filtered, in one business sentence; undefined when it can. */
const fieldRefusal = (
  facts: RecordsTableQueryFacts,
  field: string,
): RecordsTableFeatureCheck | undefined => {
  const held = factsOf(facts, field);
  if (held === undefined) {
    const label =
      facts.unselectedFields?.find(
        (candidate) => candidate.field.toLowerCase() === field.toLowerCase(),
      )?.label ?? "A chosen field";
    return featureNotPossible(
      CODE,
      `${label} cannot be filtered: it is not selected by the query.`,
    );
  }
  if (held.type === "calculation" || held.type === "total")
    return featureNotPossible(CODE, `${held.label} is a calculated field and cannot be filtered.`);
  if (!recordsTableFieldFilterable(held))
    return featureNotPossible(
      CODE,
      held.filterable
        ? `${held.label} cannot be filtered: no filter fits its type.`
        : `${held.label} cannot be filtered: its record type does not allow filtering by it.`,
    );
  return undefined;
};

export const recordsTableColumnFiltersFeature: RecordsTableFeatureDefinition<RecordsTableColumnFiltersSettings> =
  {
    key: "column_filters",
    label: "Column filters",
    description: "Filter the rows by the values of chosen fields",
    read: (group) =>
      featureEnabled(group) === true
        ? { enabled: true, fields: fieldList(group["fields"]) }
        : { enabled: false },
    // Every chosen field must be one the bound query selects and people can filter by; a feature
    // that is off needs at least one such field to be possible.
    check: (state, facts) => {
      if (!state.enabled)
        return facts.fields.some(recordsTableFieldFilterable)
          ? featureAvailable
          : featureNotPossible(CODE);
      if (state.fields.length === 0) return featureNotPossible(CODE);
      for (const field of state.fields) {
        const refusal = fieldRefusal(facts, field);
        if (refusal !== undefined) return refusal;
      }
      return featureAvailable;
    },
  };
