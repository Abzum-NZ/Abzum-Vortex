export { recordsTableRowActionsProjection } from "../../definition/application-composition/records-table-features/row-actions";
export { rowMayChangeField } from "../../definition/application-composition/records-table-features/shared";
import type {
  ConditionalFormattingProjection,
  RecordsTableContract,
  RecordsTableFeatureProjection,
  RecordsTableFilterField,
  RecordsTableInlineEditor,
  RecordsTablePivotView,
} from "../../schema";
import type {
  ProtectedQueryFieldBounds,
  ProtectedQueryRow,
} from "../../queries/protected-query-contracts";
import {
  recordsTableFeatureDefinition,
  recordsTableFeatureKeys,
  recordsTableFeatureState,
} from "../../schema";

export {
  conditionalFormattingFieldIds,
  conditionalFormattingRelativeDates,
  conditionalFormattingUsesRelativeDates,
  evaluateConditionalFormatting,
  personalFormattingAllowed,
  personalFormattingRules,
  type ConditionalFormattingContext,
  type RecordsTableRowFormat,
} from "./conditional-formatting";

/** The part of a Records table request a refusal names, kept only in the server log. */
export type RecordsTableRequestPart =
  | "contract"
  | "columns"
  | "parameters"
  | "sort"
  | "filter"
  | "search"
  | "command"
  | "cursor"
  | "bulk_action"
  | "inline_edit"
  | "row_edit"
  | "row_action"
  | "row_clicked"
  | "row_detail"
  | "tree_level"
  | "group"
  | "range_summary";

/**
 * Why the server refused a Records table request: the part and the cause. The viewer only ever
 * sees the neutral refusal; this is logged with the placement so the cause is never lost.
 */
export type RecordsTableRequestRefusal = Readonly<{
  kind: "refused";
  part: RecordsTableRequestPart;
  reason: string;
}>;

export const recordsTableRequestRefusal = (
  part: RecordsTableRequestPart,
  reason: string,
): RecordsTableRequestRefusal => Object.freeze({ kind: "refused", part, reason });

/** Logs a refused Records table request with its part and cause; the response stays neutral. */
export const logRecordsTableRequestRefusal = (
  refusal: RecordsTableRequestRefusal,
  where: string,
): void => {
  console.error(
    `[records-table] request refused where=${where} part=${refusal.part} reason=${refusal.reason}`,
  );
};

const sameField = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

/**
 * Projects the enabled features for the viewer of one read. `bounds` is the viewer's current field
 * bound from the same read, carried even when no row was returned, so it decides filters, search
 * and saved views for an empty page and for hidden columns alike; nothing is inferred from which
 * rows came back. `filterFields` describes each filterable field. Inline editing keeps only fields
 * some row lets the viewer change. Bulk named actions recheck their own permission per target;
 * broad record capabilities are not proof. Every request is re-checked by the server.
 */
export const projectRecordsTableFeatures = (
  contract: RecordsTableContract,
  bounds: ProtectedQueryFieldBounds,
  rows: readonly ProtectedQueryRow[],
  filterFields: Readonly<Record<string, RecordsTableFilterField>> | undefined,
  editors: Readonly<Record<string, RecordsTableInlineEditor>> | undefined,
  conditionalFormatting?: ConditionalFormattingProjection,
  pivotView?: RecordsTablePivotView,
  fieldLabels?: Readonly<Record<string, string>>,
  /** The viewer holds an export permission that reaches every record, decided in this read. */
  exportAllowed?: boolean,
): RecordsTableFeatureProjection | undefined => {
  const { features } = contract;
  const readable = (field: string): boolean =>
    bounds.readableFieldIds.some((fieldId) => sameField(fieldId, field));
  // Each feature that declares its projection decides its own part for this viewer.
  const context = {
    readable,
    searchable: bounds.searchable,
    filterFields,
    fieldLabels,
    pivotView,
    conditionalFormatting,
    exportAllowed: exportAllowed === true,
    features,
    columns: contract.columns,
    rows,
    editors,
    rowBehaviours: contract.rowBehaviours,
  };
  const projection = Object.fromEntries(
    recordsTableFeatureKeys.flatMap((key) => {
      const definition = recordsTableFeatureDefinition(key);
      const part = definition.project?.(recordsTableFeatureState(features, key), context);
      return part === undefined ? [] : [[definition.property, part]];
    }),
  ) as RecordsTableFeatureProjection;
  return Object.keys(projection).length === 0 ? undefined : projection;
};

/**
 * The part of the narrowing decision the table's own declaration settles before any row is read:
 * a filter on a field the installed definition gives no filter control. Whether the viewer may
 * search or filter by a field depends on their field bound, which only the read returns; that part
 * is `recordsTableNarrowingRefusal`.
 */
export const recordsTableNarrowingContractRefusal = (
  filterFields: Readonly<Record<string, unknown>>,
  narrowing: Readonly<{ filters: readonly Readonly<{ fieldId: string }>[] }>,
): RecordsTableRequestRefusal | undefined =>
  narrowing.filters.some((filter) => filterFields[filter.fieldId.toLowerCase()] === undefined)
    ? recordsTableRequestRefusal("filter", "field_not_offered")
    : undefined;

/**
 * Whether a read's own search and filters are ones its feature projection offers the viewer. The
 * read is refused, before any row leaves the server, when it searched without Search or filtered
 * by a field Column filters does not offer; a table with no projection offers neither.
 */
export const recordsTableNarrowingRefusal = (
  features: RecordsTableFeatureProjection | undefined,
  narrowing: Readonly<{ search: string | null; filters: readonly Readonly<{ fieldId: string }>[] }>,
): RecordsTableRequestRefusal | undefined => {
  if (narrowing.search !== null && features?.search !== true)
    return recordsTableRequestRefusal("search", "search_not_offered");
  const offered = features?.columnFilters ?? [];
  if (
    narrowing.filters.some(
      (filter) => !offered.some((field) => sameField(field.fieldId, filter.fieldId)),
    )
  )
    return recordsTableRequestRefusal("filter", "field_not_offered");
  return undefined;
};
