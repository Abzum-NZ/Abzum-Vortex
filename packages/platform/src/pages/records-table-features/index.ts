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
    conditionalFormatting,
    exportAllowed: exportAllowed === true,
    features,
    columns: contract.columns,
    rows,
    editors,
    rowBehaviours: contract.rowBehaviours,
  };
  const declared = Object.fromEntries(
    recordsTableFeatureKeys.flatMap((key) => {
      const definition = recordsTableFeatureDefinition(key);
      const part = definition.project?.(recordsTableFeatureState(features, key), context);
      return part === undefined ? [] : [[definition.property, part]];
    }),
  ) as Partial<RecordsTableFeatureProjection>;
  // Every expanded row is read again under the viewer's current access: the projection only says
  // rows expand; a viewer who cannot read the related records sees the panel's neutral refusal.
  const masterDetail = features.masterDetail;
  const tree = features.tree;
  // A pivot is offered only when the viewer may read its rows, columns and measure on every
  // record; the pivot read applies the same field policy again.
  const pivotSettings = features.pivot;
  const pivotFields = pivotSettings.enabled
    ? [pivotSettings.rowField, pivotSettings.columnField, pivotSettings.measureField]
    : [];
  const pivot =
    pivotSettings.enabled &&
    pivotSettings.rowPageSize !== undefined &&
    pivotSettings.rowField !== undefined &&
    pivotSettings.columnField !== undefined &&
    pivotSettings.measureFunction !== undefined &&
    pivotFields.every((field) => field === undefined || readable(field))
      ? {
          rowPageSize: pivotSettings.rowPageSize,
          totals: pivotSettings.totals,
          ...(pivotView === undefined ? {} : { view: pivotView }),
        }
      : undefined;
  // Grouping is offered only for a field the viewer is guaranteed to see on every record; a
  // withheld field is never grouped by, so no group ever stands for a value the viewer cannot read.
  const groupingSettings = features.grouping;
  const grouping =
    groupingSettings.enabled &&
    groupingSettings.field !== undefined &&
    groupingSettings.unassignedLabel !== undefined &&
    groupingSettings.opensGrouped !== undefined &&
    readable(groupingSettings.field)
      ? {
          fieldId: groupingSettings.field.toLowerCase(),
          label: fieldLabels?.[groupingSettings.field.toLowerCase()] ?? "",
          unassignedLabel: groupingSettings.unassignedLabel,
          opensGrouped: groupingSettings.opensGrouped,
        }
      : undefined;
  const projection: RecordsTableFeatureProjection = {
    ...declared,
    ...(masterDetail.enabled && masterDetail.childPageSize !== undefined
      ? { masterDetail: { pageSize: masterDetail.childPageSize } }
      : {}),
    // A tree needs the parent link among the fields the viewer is guaranteed to see.
    ...(tree.enabled &&
    tree.childPageSize !== undefined &&
    tree.parentField !== undefined &&
    readable(tree.parentField)
      ? { tree: { pageSize: tree.childPageSize } }
      : {}),
    ...(grouping === undefined || grouping.label === "" ? {} : { grouping }),
    ...(pivot === undefined ? {} : { pivot }),
  };
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
