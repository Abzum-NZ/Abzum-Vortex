import {
  factsOf,
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  optionalField,
  optionalNumber,
  type RecordsTableFeatureDefinition,
} from "./shared";

/** The most records one level of a tree reads at a time. */
export const RECORDS_TABLE_TREE_MAXIMUM_PAGE_SIZE = 200;

/**
 * Tree data: rows of a record type that links to itself expand to the records that name them as
 * their parent. `parentField` is that link, a column of the bound query, and `childPageSize` how
 * many records a level reads at a time. Each part is absent until the builder names it, which the
 * check refuses.
 */
export type RecordsTableTreeSettings = Readonly<{
  parentField?: string;
  childPageSize?: number;
}>;

const code = "definition_records_table_tree" as const;

export const recordsTableTreeFeature: RecordsTableFeatureDefinition<RecordsTableTreeSettings> = {
  key: "tree",
  label: "Tree",
  description: "Expand a row to the records that name it as their parent",
  read: (group) => {
    if (!featureEnabled(group)) return { enabled: false };
    const parentField = optionalField(group["parent_field"], "parent_field");
    const childPageSize = optionalNumber(group["child_page_size"], "child_page_size");
    return {
      enabled: true,
      ...(parentField === undefined ? {} : { parentField }),
      ...(childPageSize === undefined ? {} : { childPageSize }),
    };
  },
  // The records need a one-record link to their own record type among the query's columns; when
  // on, the chosen link must be one of them and the page size must fit the shared row budget.
  check: (state, facts) => {
    const parentLinks = facts.fields.filter((field) => field.parentLink);
    const noLink = featureNotPossible(
      code,
      `A tree needs a link from ${facts.recordTypeLabel || "these records"} to ${facts.recordTypeLabel || "themselves"} among the query's fields.`,
    );
    if (facts.grouped)
      return featureNotPossible(code, "Rows that total records cannot form a tree.");
    if (!state.enabled) return parentLinks.length === 0 ? noLink : featureAvailable;
    if (parentLinks.length === 0) return noLink;
    if (state.parentField === undefined)
      return featureNotPossible(code, "Choose the link that points to each record's parent.");
    const parent = factsOf(facts, state.parentField);
    if (parent === undefined || !parent.parentLink)
      return featureNotPossible(
        code,
        `${parent?.label ?? "The chosen field"} does not link ${facts.recordTypeLabel || "these records"} to ${facts.recordTypeLabel || "themselves"}.`,
      );
    if (state.childPageSize === undefined)
      return featureNotPossible(code, "Choose how many child records to show at a time.");
    if (
      !Number.isInteger(state.childPageSize) ||
      state.childPageSize < 1 ||
      state.childPageSize > RECORDS_TABLE_TREE_MAXIMUM_PAGE_SIZE
    )
      return featureNotPossible(
        code,
        `Show at most ${RECORDS_TABLE_TREE_MAXIMUM_PAGE_SIZE} child records at a time.`,
      );
    if (facts.maximumPageSize === undefined)
      return featureNotPossible(
        code,
        "Choose a query with a known page limit before enabling a tree.",
      );
    if (state.childPageSize > facts.maximumPageSize)
      return featureNotPossible(
        code,
        `This query allows at most ${facts.maximumPageSize} child records at a time.`,
      );
    return featureAvailable;
  },
};
