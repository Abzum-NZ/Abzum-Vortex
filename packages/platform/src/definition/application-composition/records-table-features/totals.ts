import { z } from "zod";
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
  type GridFeatureRefusal,
  type GridFeatureSettingsDeclaration,
} from "./shared";

export type RecordsTableTotalsSettings = Readonly<{
  measures: readonly Readonly<{ field: string; operation: RecordsTableAggregateOperation }>[];
}>;

/** Totals use stored numbers and money; count can count any stored field's non-null values. */
export const recordsTableAggregateSupportsType = (operation: string, type: string): boolean =>
  type !== "calculation" &&
  type !== "total" &&
  (operation === "count" || ["whole_number", "decimal_number", "money"].includes(type));

/** The feature's setting group in the Table release, off by default. */
const featureSettings = {
  kind: "group",
  key: "totals",
  label: "Totals",
  help: "Footer totals for all matching records and subtotals for each group, computed on the server",
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
      help: "Show whole-filter totals and group subtotals",
      required: false,
      defaultValue: {
        kind: "boolean",
        value: false,
      },
    },
    {
      kind: "list",
      key: "measures",
      label: "Measures",
      help: "At most six measures; hidden columns are not totalled; withheld values withhold the total",
      required: false,
      minimumItems: 1,
      maximumItems: 6,
      item: {
        kind: "group",
        key: "measure",
        label: "Measure",
        help: "A column and its aggregate",
        required: false,
        properties: [
          {
            kind: "choice",
            key: "operation",
            label: "Operation",
            help: "Count counts non-null values; distinct count requires a filterable number or money field",
            required: true,
            defaultValue: {
              kind: "choice",
              value: "sum",
            },
            options: [
              {
                key: "count",
                label: "Count",
              },
              {
                key: "sum",
                label: "Sum",
              },
              {
                key: "average",
                label: "Average",
              },
              {
                key: "minimum",
                label: "Minimum",
              },
              {
                key: "maximum",
                label: "Maximum",
              },
              {
                key: "distinct_count",
                label: "Distinct count",
              },
            ],
          },
          {
            kind: "field_reference",
            key: "field",
            label: "Column",
            help: "A selected visible column; all operations except count use number or money fields",
            required: true,
          },
        ],
      },
    },
  ],
} as const satisfies GridFeatureSettingsDeclaration;

/** The feature's refusals and their business sentences. */
const featureRefusal: GridFeatureRefusal = {
  code: "definition_records_table_totals",
  order: 39,
  message: "Totals need up to six compatible measures over the table columns.",
  guidance:
    "Choose number or money columns, or count any stored column, and turn Board and Pivot off.",
};

const projectionSchema = z.literal(true);

export const recordsTableTotalsFeature: RecordsTableFeatureDefinition<
  RecordsTableTotalsSettings,
  "totals"
> &
  Readonly<{ property: "totals"; projectionSchema: typeof projectionSchema }> = {
  key: "totals",
  property: "totals",
  projectionSchema,
  settings: featureSettings,
  refusals: [featureRefusal],
  onBoard: "unsupported",
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
  conflicts: (state, _facts, { features }) =>
    state.enabled && features.pivot.enabled
      ? featureNotPossible(
          featureRefusal,
          "Turn Pivot off to show footer totals; a pivot has its own totals.",
        )
      : undefined,
  project: (state) => (state.enabled ? true : undefined),
  check: (state, facts) => {
    if (facts.fields.length === 0)
      return featureNotPossible(featureRefusal, "Totals need a query with stored fields.");
    if (!state.enabled) return featureAvailable;
    if (state.measures.length < 1 || state.measures.length > 6)
      return featureNotPossible(
        featureRefusal,
        state.measures.length === 0
          ? "Choose the column to add up."
          : "Choose at most six columns to total.",
      );
    const keys = new Set<string>();
    const reasons: string[] = [];
    for (const measure of state.measures) {
      const field = factsOf(facts, measure.field);
      if (
        field === undefined ||
        !facts.columnFieldIds.some((column) => column.toLowerCase() === measure.field.toLowerCase())
      ) {
        reasons.push("Each total needs a column the bound query reads.");
        continue;
      }
      if (!recordsTableAggregateSupportsType(measure.operation, field.type))
        reasons.push(
          `Choose a stored number or money field for ${field.label}, or use Count on a stored field.`,
        );
      if (measure.operation === "distinct_count" && !field.filterable)
        reasons.push(`Distinct count needs ${field.label} to be filterable.`);
      const key = `${measure.field.toLowerCase()}:${measure.operation}`;
      if (keys.has(key)) reasons.push("Each column and operation can be totalled once.");
      keys.add(key);
    }
    return reasons.length === 0 ? featureAvailable : featureNotPossible(featureRefusal, reasons);
  },
};
