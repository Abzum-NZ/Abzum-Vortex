import { z } from "zod";
import {
  factsOf,
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  optionalChoice,
  optionalField,
  optionalNumber,
  recordsTablePivotDateUnits,
  requiredBoolean,
  type RecordsTableFeatureDefinition,
  type RecordsTableFieldFacts,
  type RecordsTablePivotDateUnit,
  type GridFeatureRefusal,
  type GridFeatureSettingsDeclaration,
  type RecordsTableFeatureCheck,
  type RecordsTableFeatureState,
  type RecordsTableQueryFacts,
} from "./shared";

/** The most values a pivot's column dimension may hold; the server refuses a wider one. */
export const RECORDS_TABLE_PIVOT_MAXIMUM_COLUMNS = 50;
/** The most rows one pivot page may show. */
export const RECORDS_TABLE_PIVOT_MAXIMUM_ROW_PAGE_SIZE = 200;

export const recordsTablePivotMeasureFunctions = [
  "count",
  "sum",
  "average",
  "minimum",
  "maximum",
] as const;
export type RecordsTablePivotMeasureFunction = (typeof recordsTablePivotMeasureFunctions)[number];

/** The field types a measure may total: stored numbers and money, not calculations. */
export const recordsTablePivotMeasureFieldTypes: readonly string[] = Object.freeze([
  "whole_number",
  "decimal_number",
  "money",
]);

/**
 * Pivot: the table shows its filtered records as rows crossed with columns, each cell one measure.
 * `rowField` and `columnField` are choice, link or date fields people can filter by (a date needs its
 * calendar unit); `measureFunction` counts the records or totals a number or money field
 * (`measureField`); `totals` adds the row, column and grand totals; `rowPageSize` is how many
 * rows one page shows. Each part is absent until the builder names it, which the check refuses.
 */
export type RecordsTablePivotSettings = Readonly<{
  rowField?: string;
  rowDateUnit?: RecordsTablePivotDateUnit;
  columnField?: string;
  columnDateUnit?: RecordsTablePivotDateUnit;
  measureFunction?: RecordsTablePivotMeasureFunction;
  measureField?: string;
  totals: boolean;
  rowPageSize?: number;
}>;

/** Whether a field can be a pivot dimension at all (a choice field is also bounded by its options). */
const dimensionKind = (field: RecordsTableFieldFacts): "choice" | "date" | "link" | undefined =>
  !field.filterable
    ? undefined
    : field.type === "choice"
      ? "choice"
      : field.type === "link"
        ? "link"
        : field.type === "date" || field.type === "date_time"
          ? "date"
          : undefined;

const dimensionProblem = (
  part: "rows" | "columns",
  field: RecordsTableFieldFacts | undefined,
  dateUnit: RecordsTablePivotDateUnit | undefined,
): string | undefined => {
  if (field === undefined) return `Choose the field for the ${part}.`;
  const kind = dimensionKind(field);
  if (kind === undefined)
    return `${field.label} cannot be the ${part}: choose a choice, link or date field people can filter by.`;
  if (
    part === "columns" &&
    kind === "choice" &&
    (field.choiceCount ?? 0) > RECORDS_TABLE_PIVOT_MAXIMUM_COLUMNS
  )
    return `${field.label} has more than ${RECORDS_TABLE_PIVOT_MAXIMUM_COLUMNS} choices, which is too many for a pivot.`;
  if (kind === "date" && dateUnit === undefined)
    return `Choose whether the ${part} group ${field.label} by day, week, month, quarter or year.`;
  return undefined;
};

/** The feature's setting group in the Table release, off by default. */
const featureSettings = {
  kind: "group",
  key: "pivot",
  label: "Pivot",
  help: "Show records as rows crossed with columns, totalled on the server",
  required: false,
  defaultValue: {
    kind: "group",
    properties: {
      enabled: {
        kind: "boolean",
        value: false,
      },
      totals: {
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
      help: "Let people switch the table to a pivot of its filtered records",
      required: false,
      defaultValue: {
        kind: "boolean",
        value: false,
      },
    },
    {
      kind: "field_reference",
      key: "row_field",
      label: "Rows",
      help: "A choice, link or date field people can filter by; each value is one row",
      required: false,
      fieldTypes: ["choice", "link", "date", "date_time"],
    },
    {
      kind: "choice",
      key: "row_date_unit",
      label: "Group row dates by",
      help: "The calendar unit when the rows are a date field",
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
      kind: "field_reference",
      key: "column_field",
      label: "Columns",
      help: "A choice, link or date field people can filter by, with at most 50 values",
      required: false,
      fieldTypes: ["choice", "link", "date", "date_time"],
    },
    {
      kind: "choice",
      key: "column_date_unit",
      label: "Group column dates by",
      help: "The calendar unit when the columns are a date field",
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
      kind: "choice",
      key: "measure_function",
      label: "Each cell shows",
      help: "A count of records, or a total, average, lowest or highest of a number or money field",
      required: false,
      options: [
        {
          key: "count",
          label: "Count of records",
        },
        {
          key: "sum",
          label: "Total",
        },
        {
          key: "average",
          label: "Average",
        },
        {
          key: "minimum",
          label: "Lowest",
        },
        {
          key: "maximum",
          label: "Highest",
        },
      ],
    },
    {
      kind: "field_reference",
      key: "measure_field",
      label: "Number or money field",
      help: "The field each cell totals; leave empty when counting records",
      required: false,
      fieldTypes: ["whole_number", "decimal_number", "money"],
    },
    {
      kind: "boolean",
      key: "totals",
      label: "Show totals",
      help: "Add the row, column and grand totals",
      required: false,
      defaultValue: {
        kind: "boolean",
        value: false,
      },
    },
    {
      kind: "number",
      key: "row_page_size",
      label: "Rows at a time",
      help: "How many pivot rows one page shows, at most 200",
      required: false,
      integer: true,
      minimum: 1,
      maximum: 200,
    },
  ],
} as const satisfies GridFeatureSettingsDeclaration;

/** The feature's refusals and their business sentences. */
const featureRefusal: GridFeatureRefusal = {
  code: "definition_records_table_pivot",
  order: 39,
  message: "A pivot needs two choice, link or date fields and what each cell shows.",
  guidance:
    "Choose the field for the rows, the field for the columns (at most 50 values) and what to total, or turn Pivot off.",
};

/** The feature's check against the bound query alone. */
const queryCheck = (
  state: RecordsTableFeatureState<RecordsTablePivotSettings>,
  facts: RecordsTableQueryFacts,
): RecordsTableFeatureCheck => {
  if (facts.grouped)
    return featureNotPossible(featureRefusal, "A query that totals records cannot be pivoted.");
  const dimensions = facts.fields.filter((field) => dimensionKind(field) !== undefined);
  if (dimensions.length < 2)
    return featureNotPossible(
      featureRefusal,
      `A pivot needs two choice, link or date fields of ${facts.recordTypeLabel || "this record type"} that people can filter by.`,
    );
  if (!state.enabled) return featureAvailable;
  const rows = state.rowField === undefined ? undefined : factsOf(facts, state.rowField);
  const columns = state.columnField === undefined ? undefined : factsOf(facts, state.columnField);
  const reasons = [
    dimensionProblem("rows", rows, state.rowDateUnit),
    dimensionProblem("columns", columns, state.columnDateUnit),
  ].filter((reason): reason is string => reason !== undefined);
  if (
    rows !== undefined &&
    columns !== undefined &&
    rows.field.toLowerCase() === columns.field.toLowerCase()
  )
    reasons.push("Choose different fields for the rows and the columns.");
  if (state.measureFunction === undefined)
    reasons.push("Choose what each cell shows: a count or a total.");
  else if (state.measureFunction !== "count") {
    const measure =
      state.measureField === undefined ? undefined : factsOf(facts, state.measureField);
    if (measure === undefined) reasons.push("Choose the number or money field each cell totals.");
    else if (!recordsTablePivotMeasureFieldTypes.includes(measure.type))
      reasons.push(`${measure.label} is not a number or money field, so it cannot be totalled.`);
  } else if (state.measureField !== undefined)
    reasons.push("A count has no field to total: clear the field or choose a total.");
  if (
    state.rowPageSize === undefined ||
    !Number.isInteger(state.rowPageSize) ||
    state.rowPageSize < 1 ||
    state.rowPageSize > RECORDS_TABLE_PIVOT_MAXIMUM_ROW_PAGE_SIZE
  )
    reasons.push(
      `Show between 1 and ${RECORDS_TABLE_PIVOT_MAXIMUM_ROW_PAGE_SIZE} pivot rows at a time.`,
    );
  return reasons.length === 0 ? featureAvailable : featureNotPossible(featureRefusal, reasons);
};

const textSchema = z.string().min(1);
const positiveSchema = z.number().int().min(1);
const projectionSchema = z
  .object({
    rowPageSize: positiveSchema,
    totals: z.boolean(),
    view: z.object({ cursor: textSchema.optional() }).strict().readonly().optional(),
  })
  .strict()
  .readonly();

export const recordsTablePivotFeature: RecordsTableFeatureDefinition<
  RecordsTablePivotSettings,
  "pivot"
> &
  Readonly<{ property: "pivot"; projectionSchema: typeof projectionSchema }> = {
  key: "pivot",
  property: "pivot",
  projectionSchema,
  settings: featureSettings,
  refusals: [featureRefusal],
  onBoard: "unsupported",
  label: "Pivot",
  description: "Show records as rows crossed with columns, totalled on the server",
  read: (group) => {
    if (!featureEnabled(group)) return { enabled: false };
    const rowField = optionalField(group["row_field"], "row_field");
    const columnField = optionalField(group["column_field"], "column_field");
    const measureField = optionalField(group["measure_field"], "measure_field");
    const rowDateUnit = optionalChoice(
      group["row_date_unit"],
      recordsTablePivotDateUnits,
      "row_date_unit",
    );
    const columnDateUnit = optionalChoice(
      group["column_date_unit"],
      recordsTablePivotDateUnits,
      "column_date_unit",
    );
    const measureFunction = optionalChoice(
      group["measure_function"],
      recordsTablePivotMeasureFunctions,
      "measure_function",
    );
    const rowPageSize = optionalNumber(group["row_page_size"], "row_page_size");
    return {
      enabled: true,
      ...(rowField === undefined ? {} : { rowField }),
      ...(rowDateUnit === undefined ? {} : { rowDateUnit }),
      ...(columnField === undefined ? {} : { columnField }),
      ...(columnDateUnit === undefined ? {} : { columnDateUnit }),
      ...(measureFunction === undefined ? {} : { measureFunction }),
      ...(measureField === undefined ? {} : { measureField }),
      totals: requiredBoolean(group["totals"], "totals"),
      ...(rowPageSize === undefined ? {} : { rowPageSize }),
    };
  },
  // A pivot is offered only when the viewer may read its rows, columns and measure on every
  // record; the pivot read applies the same field policy again.
  project: (state, { readable, pivotView }) =>
    state.enabled &&
    state.rowPageSize !== undefined &&
    state.rowField !== undefined &&
    state.columnField !== undefined &&
    state.measureFunction !== undefined &&
    [state.rowField, state.columnField, state.measureField].every(
      (field) => field === undefined || readable(field),
    )
      ? {
          rowPageSize: state.rowPageSize,
          totals: state.totals,
          ...(pivotView === undefined ? {} : { view: pivotView }),
        }
      : undefined,
  // A pivot needs two different dimensions the bound query selects: a choice field (at most 50
  // choices as columns), a link or a date field, each one people can filter by. When on, the rows,
  // the columns, what the cells total and the page size must all fit; each refusal names the part
  // that does not.
  conflicts: (state, _facts, { features }) =>
    state.enabled && features.tree.enabled
      ? featureNotPossible(featureRefusal, "Turn Tree off to pivot the records.")
      : undefined,
  // Opening a pivot cell filters the table through Column filters, so both dimensions must be
  // among this table's enabled Column filters fields, not merely among its displayed columns.
  check: (state, facts, { features }) => {
    const check = queryCheck(state, facts);
    if (!state.enabled) return check;
    const reasons = check.kind === "not_possible" ? [check.reason] : [];
    const filterable = features.columnFilters.enabled ? features.columnFilters.fields : [];
    for (const [part, field] of [
      ["rows", state.rowField],
      ["columns", state.columnField],
    ] as const) {
      if (
        field === undefined ||
        filterable.some((candidate) => candidate.toLowerCase() === field.toLowerCase())
      )
        continue;
      const label =
        facts.fields.find((candidate) => candidate.field.toLowerCase() === field.toLowerCase())
          ?.label ?? field;
      reasons.push(`Add ${label} to Column filters so people can drill into pivot ${part}.`);
    }
    return reasons.length === 0 ? featureAvailable : featureNotPossible(featureRefusal, reasons);
  },
};
