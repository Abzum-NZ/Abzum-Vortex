import type { InlineQueryAggregate } from "./module-query-edit";

/** Field types a sum or an average adds up. */
export const queryNumericTotalFieldTypes: ReadonlySet<string> = new Set([
  "whole_number",
  "decimal_number",
  "money",
]);
/** Field types a lowest or highest value is taken of. */
export const queryExtremeTotalFieldTypes: ReadonlySet<string> = new Set([
  "text",
  "whole_number",
  "decimal_number",
  "yes_no",
  "money",
  "date",
  "date_time",
]);

/** The fields of a total's operation it can be taken of; a count takes none. */
export const queryTotalAccepts = (
  operation: InlineQueryAggregate["operation"],
  fieldType: string,
): boolean =>
  operation === "count"
    ? false
    : operation === "distinct_count"
      ? fieldType !== "total" && fieldType !== "calculation"
      : operation === "sum" || operation === "average"
        ? queryNumericTotalFieldTypes.has(fieldType)
        : queryExtremeTotalFieldTypes.has(fieldType);

export const queryTotalOperationLabels = {
  count: "Number of records",
  sum: "Sum",
  average: "Average",
  minimum: "Lowest",
  maximum: "Highest",
  distinct_count: "Number of different values",
} as const satisfies Record<InlineQueryAggregate["operation"], string>;
