import "server-only";

import type { BlockPropertyValueContract } from "../../definition/application-composition/block-property-values";
import { recordsTableContractOrLog } from "../../definition/application-composition/records-display";
import type {
  RecordsTableTotal,
  RecordsTableAggregateOperation,
} from "../../definition/application-composition/records-table-totals";
import type { ProtectedQuerySummaryAggregateResult } from "../../queries/protected-query-contracts";
import { formatDecimal, formatMoney, isExactDecimal } from "../value-format";

export type RecordsTableTotalRead = Readonly<{
  fieldId: string;
  operation: RecordsTableAggregateOperation;
  alias: string;
}>;

/** The installed settings and resolved visible columns are the only source of requested totals. */
export const recordsTableTotalReads = (
  settings: Readonly<Record<string, BlockPropertyValueContract>>,
  visible: readonly string[],
): readonly RecordsTableTotalRead[] => {
  const contract = recordsTableContractOrLog(settings, "table totals");
  if (contract === undefined) throw new Error("GRID_TOTALS_CONTRACT_UNREADABLE");
  const feature = contract.features.totals;
  // Publication refuses totals beside a board or a pivot, so the feature alone decides.
  if (!feature.enabled) return [];
  const shown = new Set(visible.map((field) => field.toLowerCase()));
  return feature.measures.flatMap((measure, index) =>
    !shown.has(measure.field.toLowerCase())
      ? []
      : [
          {
            fieldId: measure.field.toLowerCase(),
            operation: measure.operation,
            alias: `total_${index}`,
          },
        ],
  );
};

/** Permission and currency refusals carry no raw value or count to the browser. */
export const projectRecordsTableTotals = (
  requested: readonly RecordsTableTotalRead[],
  aggregates: Readonly<Record<string, ProtectedQuerySummaryAggregateResult>> | undefined,
): readonly RecordsTableTotal[] =>
  requested.map(({ fieldId, operation, alias }) => {
    const identity = { fieldId: fieldId as RecordsTableTotal["fieldId"], operation };
    if (aggregates === undefined) return { ...identity, state: "unavailable" };
    const result = aggregates[alias];
    if (result === undefined) throw new Error("GRID_TOTAL_RESULT_MISSING");
    if (result.outcome === "refused")
      return {
        ...identity,
        state:
          result.reasonCode === "read_forbidden"
            ? "withheld"
            : result.reasonCode === "mixed_currency"
              ? "mixed_currency"
              : "unavailable",
      };
    if (result.value === null) return { ...identity, state: "empty" };
    const value = result.value;
    let text: string;
    if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof value.amount === "string" &&
      typeof value.currency === "string"
    )
      text = formatMoney({ amount: value.amount, currency: value.currency });
    else if (typeof value === "number" || (typeof value === "string" && isExactDecimal(value)))
      text = formatDecimal(value);
    else if (typeof value === "string") text = value;
    else if (typeof value === "boolean") text = value ? "Yes" : "No";
    else throw new Error("GRID_TOTAL_VALUE_INVALID");
    return { ...identity, state: "value", text };
  });
