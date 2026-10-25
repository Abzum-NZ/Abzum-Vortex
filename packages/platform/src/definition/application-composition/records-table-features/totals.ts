import {
  recordsTableAggregateOperations,
  type RecordsTableAggregateOperation,
} from "../records-table-totals";
import {
  factsOf,
  featureAvailable,
  featureEnabled,
  featureNotPossible,
  requiredChoice,
  requiredField,
  requiredGroup,
  requiredItems,
  type RecordsTableFeatureDefinition,
} from "./shared";

export type RecordsTableTotalsSettings = Readonly<{
  measures: readonly Readonly<{ field: string; operation: RecordsTableAggregateOperation }>[];
}>;

/** Totals use stored numbers and money; count can count any stored field's non-null values. */
export const recordsTableAggregateSupportsType = (operation: string, type: string): boolean =>
  type !== "calculation" &&
  type !== "total" &&
  (operation === "count" || ["whole_number", "decimal_number", "money"].includes(type));

const code = "definition_records_table_totals";
export const recordsTableTotalsFeature: RecordsTableFeatureDefinition<RecordsTableTotalsSettings> =
  {
    key: "totals",
    label: "Totals",
    description: "Footer totals over all matching records and subtotals for every group",
    read: (group) => {
      if (!featureEnabled(group)) return { enabled: false };
      return {
        enabled: true,
        measures: requiredItems(group["measures"], "measures").map((item, index) => {
          const at = `measures[${index}]`;
          const measure = requiredGroup(item, at);
          return {
            field: requiredField(measure["field"], `${at}.field`),
            operation: requiredChoice(
              measure["operation"],
              recordsTableAggregateOperations,
              `${at}.operation`,
            ),
          };
        }),
      };
    },
    check: (state, facts) => {
      if (facts.fields.length === 0)
        return featureNotPossible(code, "Totals need a query with stored fields.");
      if (!state.enabled) return featureAvailable;
      if (state.measures.length < 1 || state.measures.length > 6)
        return featureNotPossible(code, "Choose between one and six measures for this grid.");
      const keys = new Set<string>();
      for (const measure of state.measures) {
        const field = factsOf(facts, measure.field);
        if (
          field === undefined ||
          !facts.columnFieldIds.some(
            (column) => column.toLowerCase() === measure.field.toLowerCase(),
          )
        )
          return featureNotPossible(code, "Each total needs a column the bound query reads.");
        if (!recordsTableAggregateSupportsType(measure.operation, field.type))
          return featureNotPossible(
            code,
            `Choose a stored number or money field for ${field.label}, or use Count on a stored field.`,
          );
        if (measure.operation === "distinct_count" && !field.filterable)
          return featureNotPossible(code, `Distinct count needs ${field.label} to be filterable.`);
        const key = `${measure.field.toLowerCase()}:${measure.operation}`;
        if (keys.has(key))
          return featureNotPossible(code, "Each column and operation can be totalled once.");
        keys.add(key);
      }
      return featureAvailable;
    },
  };
