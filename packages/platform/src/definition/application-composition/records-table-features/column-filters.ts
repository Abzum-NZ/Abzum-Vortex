import {
  factsOf,
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  requiredFieldList,
  type RecordsTableBoardFacts,
  type RecordsTableFeatureCheck,
  type RecordsTableFeatureDefinition,
  type RecordsTableFieldFacts,
  type RecordsTableQueryFacts,
  type GridFeatureRefusal,
  type GridFeatureSettingsDeclaration,
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
      featureRefusal,
      `${label} cannot be filtered: it is not selected by the query.`,
    );
  }
  if (held.type === "calculation" || held.type === "total")
    return featureNotPossible(
      featureRefusal,
      `${held.label} is a calculated field and cannot be filtered.`,
    );
  if (!recordsTableFieldFilterable(held))
    return featureNotPossible(
      featureRefusal,
      held.filterable
        ? `${held.label} cannot be filtered: no filter fits its type.`
        : `${held.label} cannot be filtered: its record type does not allow filtering by it.`,
    );
  return undefined;
};

/** The feature's setting group in the Table release, off by default. */
const featureSettings = {
  kind: "group",
  key: "column_filters",
  label: "Column filters",
  help: "Filter controls for chosen fields of the bound query",
  required: false,
  defaultValue: {
    kind: "group",
    properties: {
      enabled: {
        kind: "boolean",
        value: false,
      },
      fields: {
        kind: "list",
        items: [],
      },
    },
  },
  properties: [
    {
      kind: "boolean",
      key: "enabled",
      label: "On",
      help: "Show filter controls",
      required: false,
      defaultValue: {
        kind: "boolean",
        value: false,
      },
    },
    {
      kind: "list",
      key: "fields",
      label: "Filter fields",
      help: "Fields a person may filter by; each must be filterable in the bound query",
      required: false,
      minimumItems: 0,
      maximumItems: 50,
      item: {
        kind: "field_reference",
        key: "field",
        label: "Field",
        help: "Field of the bound query people filter by",
        required: true,
      },
      defaultValue: {
        kind: "list",
        items: [],
      },
    },
  ],
} as const satisfies GridFeatureSettingsDeclaration;

/** The feature's refusals and their business sentences. */
const featureRefusal: GridFeatureRefusal = {
  code: "definition_records_table_column_filters",
  order: 37,
  message: "Add a field to filter by.",
  guidance:
    "Choose stored fields the bound query selects and its record type allows filtering by, or turn Column filters off.",
};

export const recordsTableColumnFiltersFeature: RecordsTableFeatureDefinition<
  RecordsTableColumnFiltersSettings,
  "column_filters"
> &
  Readonly<{ property: "columnFilters" }> = {
  key: "column_filters",
  property: "columnFilters",
  settings: featureSettings,
  refusals: [featureRefusal],
  onBoard: "supported",
  events: { filter_changed: {} },
  label: "Column filters",
  description: "Filter the rows by the values of chosen fields",
  read: (group) =>
    featureEnabled(group)
      ? { enabled: true, fields: requiredFieldList(group["fields"], "fields") }
      : { enabled: false },
  // Every chosen field must be one the bound query selects and people can filter by; a feature
  // that is off needs at least one such field to be possible.
  // On a board the cards narrow over every field of the record type.
  boardCheck: (state, board) =>
    state.enabled ? boardFilterProblem(state.fields, board) : undefined,
  // A declared field the installed definition gives no filter control, or that the viewer may not
  // read on every record, is not offered; the read refuses a filter on it.
  project: (state, { readable, filterFields }) => {
    if (!state.enabled) return undefined;
    const offered = state.fields.flatMap((field) => {
      const described = filterFields?.[field.toLowerCase()];
      return described === undefined || !readable(field) ? [] : [described];
    });
    return offered.length === 0 ? undefined : offered;
  },
  check: (state, facts) => {
    if (!state.enabled)
      return facts.fields.some(recordsTableFieldFilterable)
        ? featureAvailable
        : featureNotPossible(featureRefusal);
    if (state.fields.length === 0) return featureNotPossible(featureRefusal);
    const reasons = state.fields.flatMap((field) => {
      const refusal = fieldRefusal(facts, field);
      return refusal?.kind === "not_possible" ? [refusal.reason] : [];
    });
    return reasons.length === 0 ? featureAvailable : featureNotPossible(featureRefusal, reasons);
  },
};

/**
 * Why the fields a board's Column filters chose cannot narrow its cards, as one business sentence,
 * or undefined when each can. A board filters over every field of its record type, not only the
 * ones its cards show; a filter on linked records needs a record picker the board does not draw.
 */
export const boardFilterProblem = (
  fields: readonly string[],
  board: RecordsTableBoardFacts,
): Extract<RecordsTableFeatureCheck, { kind: "not_possible" }> | undefined => {
  const refuseFilters = (
    reason: string,
  ): Extract<RecordsTableFeatureCheck, { kind: "not_possible" }> =>
    featureNotPossible(featureRefusal, reason) as Extract<
      RecordsTableFeatureCheck,
      { kind: "not_possible" }
    >;
  if (fields.length === 0)
    return refuseFilters("Choose at least one field to filter the cards by.");
  for (const field of fields) {
    const held = board.fields.find(
      (candidate) => candidate.field.toLowerCase() === field.toLowerCase(),
    );
    if (held === undefined)
      return refuseFilters(`A chosen filter field is not a field of ${board.queryLabel}.`);
    if (held.type === "calculation" || held.type === "total")
      return refuseFilters(`${held.label} is a calculated field and cannot be filtered.`);
    if (!held.filterable)
      return refuseFilters(
        `${held.label} cannot be filtered: its record type does not allow filtering by it.`,
      );
    const kind = recordsTableFilterKindOf(held.type);
    if (kind === undefined)
      return refuseFilters(`${held.label} cannot be filtered: no filter fits its type.`);
    if (kind === "link")
      return refuseFilters(
        `${held.label} links to other records, and a board cannot filter by linked records yet.`,
      );
  }
  return undefined;
};
