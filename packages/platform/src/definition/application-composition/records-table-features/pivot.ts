import {
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  factsOf,
  settingField,
  settingOptionalChoice,
  type RecordsTableFeatureDefinition,
  type RecordsTableFieldFacts,
} from "./shared";

/** The most values a pivot's column dimension may hold; the server refuses a wider one. */
export const RECORDS_TABLE_PIVOT_MAXIMUM_COLUMNS = 50;
/** The most rows one pivot page may show. */
export const RECORDS_TABLE_PIVOT_MAXIMUM_ROW_PAGE_SIZE = 200;

export const recordsTablePivotDateUnits = ["day", "week", "month", "quarter", "year"] as const;
export type RecordsTablePivotDateUnit = (typeof recordsTablePivotDateUnits)[number];
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
 * `rowField` and `columnField` are choice or date fields people can filter by (a date needs its
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

const code = "definition_records_table_pivot" as const;

/** Whether a field can be a pivot dimension at all (a choice field is also bounded by its options). */
const dimensionKind = (field: RecordsTableFieldFacts): "choice" | "date" | undefined =>
  !field.filterable
    ? undefined
    : field.type === "choice"
      ? "choice"
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
    return `${field.label} cannot be the ${part}: choose a choice or date field people can filter by.`;
  if (kind === "choice" && (field.choiceCount ?? 0) > RECORDS_TABLE_PIVOT_MAXIMUM_COLUMNS)
    return `${field.label} has more than ${RECORDS_TABLE_PIVOT_MAXIMUM_COLUMNS} choices, which is too many for a pivot.`;
  if (kind === "date" && dateUnit === undefined)
    return `Choose whether the ${part} group ${field.label} by day, week, month, quarter or year.`;
  return undefined;
};

export const recordsTablePivotFeature: RecordsTableFeatureDefinition<RecordsTablePivotSettings> = {
  key: "pivot",
  label: "Pivot",
  description: "Show records as rows crossed with columns, totalled on the server",
  read: (group) => {
    if (featureEnabled(group) !== true) return { enabled: false };
    const rowField = settingField(group["row_field"]);
    const columnField = settingField(group["column_field"]);
    const measureField = settingField(group["measure_field"]);
    const rowDateUnit = settingOptionalChoice(group["row_date_unit"], recordsTablePivotDateUnits);
    const columnDateUnit = settingOptionalChoice(
      group["column_date_unit"],
      recordsTablePivotDateUnits,
    );
    const measureFunction = settingOptionalChoice(
      group["measure_function"],
      recordsTablePivotMeasureFunctions,
    );
    const rowPageSize = group["row_page_size"];
    const totals = group["totals"];
    return {
      enabled: true,
      ...(rowField === undefined ? {} : { rowField }),
      ...(rowDateUnit === undefined ? {} : { rowDateUnit }),
      ...(columnField === undefined ? {} : { columnField }),
      ...(columnDateUnit === undefined ? {} : { columnDateUnit }),
      ...(measureFunction === undefined ? {} : { measureFunction }),
      ...(measureField === undefined ? {} : { measureField }),
      totals: totals?.kind === "boolean" && totals.value,
      ...(rowPageSize?.kind === "number" ? { rowPageSize: rowPageSize.value } : {}),
    };
  },
  // A pivot needs two different dimensions the bound query selects: a choice field with at most 50
  // choices or a date field, each one people can filter by. When on, the rows, the columns, what
  // the cells total and the page size must all fit; each refusal names the part that does not.
  check: (state, facts) => {
    if (facts.grouped)
      return featureNotPossible(code, "A query that totals records cannot be pivoted.");
    const dimensions = facts.fields.filter(
      (field) =>
        dimensionKind(field) !== undefined &&
        (dimensionKind(field) !== "choice" ||
          (field.choiceCount ?? 0) <= RECORDS_TABLE_PIVOT_MAXIMUM_COLUMNS),
    );
    if (dimensions.length < 2)
      return featureNotPossible(
        code,
        `A pivot needs two choice or date fields of ${facts.recordTypeLabel || "this record type"} that people can filter by.`,
      );
    if (!state.enabled) return featureAvailable;
    const rows = state.rowField === undefined ? undefined : factsOf(facts, state.rowField);
    const columns = state.columnField === undefined ? undefined : factsOf(facts, state.columnField);
    const rowProblem = dimensionProblem("rows", rows, state.rowDateUnit);
    if (rowProblem !== undefined) return featureNotPossible(code, rowProblem);
    const columnProblem = dimensionProblem("columns", columns, state.columnDateUnit);
    if (columnProblem !== undefined) return featureNotPossible(code, columnProblem);
    if (rows!.field.toLowerCase() === columns!.field.toLowerCase())
      return featureNotPossible(code, "Choose different fields for the rows and the columns.");
    if (state.measureFunction === undefined)
      return featureNotPossible(code, "Choose what each cell shows: a count or a total.");
    if (state.measureFunction !== "count") {
      const measure =
        state.measureField === undefined ? undefined : factsOf(facts, state.measureField);
      if (measure === undefined)
        return featureNotPossible(code, "Choose the number or money field each cell totals.");
      if (!recordsTablePivotMeasureFieldTypes.includes(measure.type))
        return featureNotPossible(
          code,
          `${measure.label} is not a number or money field, so it cannot be totalled.`,
        );
    } else if (state.measureField !== undefined)
      return featureNotPossible(
        code,
        "A count has no field to total: clear the field or choose a total.",
      );
    if (
      state.rowPageSize === undefined ||
      !Number.isInteger(state.rowPageSize) ||
      state.rowPageSize < 1 ||
      state.rowPageSize > RECORDS_TABLE_PIVOT_MAXIMUM_ROW_PAGE_SIZE
    )
      return featureNotPossible(
        code,
        `Show between 1 and ${RECORDS_TABLE_PIVOT_MAXIMUM_ROW_PAGE_SIZE} pivot rows at a time.`,
      );
    return featureAvailable;
  },
};
