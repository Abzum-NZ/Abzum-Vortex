import { z } from "zod";
import {
  factsOf,
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  optionalField,
  optionalNumber,
  type RecordsTableFeatureDefinition,
  type GridFeatureRefusal,
  type GridFeatureSettingsDeclaration,
  type RecordsTableFeatureCheck,
  type RecordsTableFeatureState,
  type RecordsTableQueryFacts,
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

/** The feature's setting group in the Table release, off by default. */
const featureSettings = {
  kind: "group",
  key: "tree",
  label: "Tree",
  help: "Expand a row to the records that name it as their parent",
  required: false,
  defaultValue: {
    kind: "group",
    properties: {
      enabled: {
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
      help: "Let people expand a row to the records beneath it",
      required: false,
      defaultValue: {
        kind: "boolean",
        value: false,
      },
    },
    {
      kind: "field_reference",
      key: "parent_field",
      label: "Parent link",
      help: "The link from each record to its parent record",
      required: false,
    },
    {
      kind: "number",
      key: "child_page_size",
      label: "Child records at a time",
      help: "How many records an expanded row reads at a time, at most 200",
      required: false,
      integer: true,
      minimum: 1,
      maximum: 200,
    },
  ],
} as const satisfies GridFeatureSettingsDeclaration;

/** The feature's refusals and their business sentences. */
const featureRefusal: GridFeatureRefusal = {
  code: "definition_records_table_tree",
  order: 39,
  message: "A tree needs a link from these records to themselves.",
  guidance:
    "Choose the link that points to each record's parent and how many child records to show at a time, or turn Tree off.",
};

/** The feature's check against the bound query alone. */
const queryCheck = (
  state: RecordsTableFeatureState<RecordsTableTreeSettings>,
  facts: RecordsTableQueryFacts,
): RecordsTableFeatureCheck => {
  const parentLinks = facts.fields.filter((field) => field.parentLink);
  const noLink = featureNotPossible(
    featureRefusal,
    `A tree needs a link from ${facts.recordTypeLabel || "these records"} to ${facts.recordTypeLabel || "themselves"} among the query's fields.`,
  );
  if (facts.grouped)
    return featureNotPossible(featureRefusal, "Rows that total records cannot form a tree.");
  if (!state.enabled) return parentLinks.length === 0 ? noLink : featureAvailable;
  if (parentLinks.length === 0) return noLink;
  if (state.parentField === undefined)
    return featureNotPossible(
      featureRefusal,
      "Choose the link that points to each record's parent.",
    );
  const parent = factsOf(facts, state.parentField);
  if (parent === undefined || !parent.parentLink)
    return featureNotPossible(
      featureRefusal,
      `${parent?.label ?? "The chosen field"} does not link ${facts.recordTypeLabel || "these records"} to ${facts.recordTypeLabel || "themselves"}.`,
    );
  if (state.childPageSize === undefined)
    return featureNotPossible(featureRefusal, "Choose how many child records to show at a time.");
  if (
    !Number.isInteger(state.childPageSize) ||
    state.childPageSize < 1 ||
    state.childPageSize > RECORDS_TABLE_TREE_MAXIMUM_PAGE_SIZE
  )
    return featureNotPossible(
      featureRefusal,
      `Show at most ${RECORDS_TABLE_TREE_MAXIMUM_PAGE_SIZE} child records at a time.`,
    );
  if (facts.maximumPageSize === undefined)
    return featureNotPossible(
      featureRefusal,
      "Choose a query with a known page limit before enabling a tree.",
    );
  if (state.childPageSize > facts.maximumPageSize)
    return featureNotPossible(
      featureRefusal,
      `This query allows at most ${facts.maximumPageSize} child records at a time.`,
    );
  return featureAvailable;
};

const positiveSchema = z.number().int().min(1);
const projectionSchema = z.object({ pageSize: positiveSchema }).strict().readonly();

export const recordsTableTreeFeature: RecordsTableFeatureDefinition<
  RecordsTableTreeSettings,
  "tree"
> &
  Readonly<{ property: "tree"; projectionSchema: typeof projectionSchema }> = {
  key: "tree",
  property: "tree",
  projectionSchema,
  settings: featureSettings,
  refusals: [featureRefusal],
  onBoard: "own",
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
  // A tree needs the parent link among the fields the viewer is guaranteed to see.
  project: (state, { readable }) =>
    state.enabled &&
    state.childPageSize !== undefined &&
    state.parentField !== undefined &&
    readable(state.parentField)
      ? { pageSize: state.childPageSize }
      : undefined,
  // The records need a one-record link to their own record type among the query's columns; when
  // on, the chosen link must be one of them and the page size must fit the shared row budget.
  conflicts: (state, _facts, { features }) => {
    if (state.enabled && features.board.enabled)
      return featureNotPossible(featureRefusal, "Turn Board off to show records as a tree.");
    // A row opens one panel: its related records or the records beneath it, never both.
    if (state.enabled && features.masterDetail.enabled)
      return featureNotPossible(
        featureRefusal,
        "A row shows either its related records or the records beneath it; turn Related records off to use a tree.",
      );
    return undefined;
  },
  // The table's page and one page of child records must fit the rows a tree table holds at once.
  check: (state, facts, { tablePageSize }) => {
    const check = queryCheck(state, facts);
    if (
      check.kind !== "not_possible" &&
      state.enabled &&
      state.childPageSize !== undefined &&
      tablePageSize !== undefined &&
      tablePageSize + state.childPageSize > RECORDS_TABLE_TREE_MAXIMUM_PAGE_SIZE
    )
      return featureNotPossible(
        featureRefusal,
        `A tree table shows at most ${RECORDS_TABLE_TREE_MAXIMUM_PAGE_SIZE} rows at once: its ${tablePageSize} records a page and ${state.childPageSize} child records at a time do not fit. Lower one of them.`,
      );
    return check;
  },
};
