import type {
  RecordsTableActionContract,
  RecordsTableContract,
  RecordsTableFilterField,
} from "../../schema";
import type {
  ProtectedQueryFieldBounds,
  ProtectedQueryRow,
} from "../../queries/protected-query-contracts";
import type { ConditionalFormattingProjection } from "./conditional-formatting";

export {
  conditionalFormattingFieldIds,
  conditionalFormattingRelativeDates,
  conditionalFormattingUsesRelativeDates,
  evaluateConditionalFormatting,
  type ConditionalColumnFormatProjection,
  type ConditionalFormattingContext,
  type ConditionalFormattingProjection,
  type RecordsTableRowFormat,
} from "./conditional-formatting";

/**
 * The grid features one viewer may use on one Records table read: each feature the release turns
 * on (publication already refused any that does not fit the bound query), narrowed to what the
 * viewer may do now. It is computed once per read, from the field bound and the per-row
 * capabilities the Query engine decided in that same read under the viewer's current access and
 * field policy, and travels in the table payload; there is no separate request and nothing is
 * cached. The same projection both draws the controls and decides whether the read's own search
 * and filters were allowed. A feature that is off for the viewer is absent, and a table with every
 * feature off carries no projection at all.
 */
export type RecordsTableFeatureProjection = Readonly<{
  pinning?: true;
  /** Present when the viewer can read some field the record type marks searchable. */
  search?: true;
  /**
   * The filterable fields the viewer may filter by, each with its canonical type, filter kind and
   * what its control needs (choice options, a fixed currency, the organisation time zone).
   */
  columnFilters?: readonly RecordsTableFilterField[];
  /** Present when the viewer can filter by some field or sort by some field it can read. */
  savedViews?: true;
  /** The bulk commands at least one row of the page lets the viewer run. */
  bulkActions?: readonly RecordsTableActionContract[];
  /** The fields the viewer may change on at least one row, and the flow binding that commits a change. */
  inlineEdit?: Readonly<{ eventId: string; fields: readonly string[] }>;
  /** Rows expand to their related records, read this many at a time. */
  masterDetail?: Readonly<{ pageSize: number }>;
  /** The styles the page's rows name and the numeric columns drawn as bars or scales. */
  conditionalFormatting?: ConditionalFormattingProjection;
}>;

/** The part of a Records table request a refusal names, kept only in the server log. */
export type RecordsTableRequestPart =
  | "contract"
  | "columns"
  | "parameters"
  | "sort"
  | "filter"
  | "search"
  | "command"
  | "bulk_action"
  | "inline_edit"
  | "row_action"
  | "row_clicked"
  | "row_detail";

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

/** The inline-edit fields some row lets the viewer change now; none when inline editing is off. */
export const recordsTableEditableFields = (
  contract: RecordsTableContract,
  rows: readonly ProtectedQueryRow[],
): readonly string[] => {
  const inlineEdit = contract.features.inlineEdit;
  return inlineEdit.enabled && inlineEdit.eventId !== undefined
    ? inlineEdit.fields.filter((field) =>
        rows.some(
          (row) =>
            row.capabilities?.actions.includes("update") === true &&
            row.capabilities.changeableFieldIds.some((fieldId) => sameField(fieldId, field)),
        ),
      )
    : [];
};

/**
 * Projects the enabled features for the viewer of one read. `bounds` is the viewer's current field
 * bound from the same read, carried even when no row was returned, so it decides filters, search
 * and saved views for an empty page and for hidden columns alike; nothing is inferred from which
 * rows came back. `filterFields` describes each filterable field. A bulk command that names a
 * capability is offered when some row allows it, and inline editing keeps only fields some row
 * lets the viewer change. Every request a projected control makes is still re-checked by the server.
 */
export const projectRecordsTableFeatures = (
  contract: RecordsTableContract,
  bounds: ProtectedQueryFieldBounds,
  rows: readonly ProtectedQueryRow[],
  filterFields: Readonly<Record<string, RecordsTableFilterField>> | undefined,
  conditionalFormatting?: ConditionalFormattingProjection,
): RecordsTableFeatureProjection | undefined => {
  const { features } = contract;
  const readable = (field: string): boolean =>
    bounds.readableFieldIds.some((fieldId) => sameField(fieldId, field));
  // A declared filter field the installed definition gives no filter kind, or that the viewer may
  // not read on every record, is not offered; the read refuses a filter on it.
  const columnFilters = features.columnFilters.enabled
    ? features.columnFilters.fields.flatMap((field) => {
        const described = filterFields?.[field.toLowerCase()];
        return described === undefined || !readable(field) ? [] : [described];
      })
    : [];
  const search = features.search.enabled && bounds.searchable;
  // A view keeps a sort or a filter, so it is offered only when the viewer has one to keep.
  const savedViews =
    features.savedViews.enabled &&
    (columnFilters.length > 0 || contract.sortableFields.some((field) => readable(field)));
  const bulkActions = features.bulkActions.enabled
    ? features.bulkActions.actions.filter(
        (action) =>
          action.capability === undefined ||
          rows.some((row) => row.capabilities?.actions.includes(action.capability!) === true),
      )
    : [];
  const inlineEdit = features.inlineEdit;
  const editableFields = recordsTableEditableFields(contract, rows);
  // Every expanded row is read again under the viewer's current access: the projection only says
  // rows expand; a viewer who cannot read the related records sees the panel's neutral refusal.
  const masterDetail = features.masterDetail;
  const projection: RecordsTableFeatureProjection = {
    ...(features.pinning.enabled ? { pinning: true as const } : {}),
    ...(search ? { search: true as const } : {}),
    ...(columnFilters.length === 0 ? {} : { columnFilters }),
    ...(savedViews ? { savedViews: true as const } : {}),
    ...(bulkActions.length === 0 ? {} : { bulkActions }),
    ...(editableFields.length === 0 || !inlineEdit.enabled || inlineEdit.eventId === undefined
      ? {}
      : { inlineEdit: { eventId: inlineEdit.eventId, fields: editableFields } }),
    ...(masterDetail.enabled && masterDetail.childPageSize !== undefined
      ? { masterDetail: { pageSize: masterDetail.childPageSize } }
      : {}),
    ...(conditionalFormatting === undefined || !features.conditionalFormatting.enabled
      ? {}
      : { conditionalFormatting }),
  };
  return Object.keys(projection).length === 0 ? undefined : projection;
};

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
