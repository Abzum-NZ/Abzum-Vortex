import type {
  RecordsTableBulkActionContract,
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
  spreadsheet?: Readonly<{ rangeSelect: boolean; find: boolean }>;
  /** Present when the viewer can read some field the record type marks searchable. */
  search?: true;
  /**
   * The filterable fields the viewer may filter by, each with its canonical type, filter kind and
   * what its control needs (choice options, a fixed currency, the organisation time zone).
   */
  columnFilters?: readonly RecordsTableFilterField[];
  /** Present when the viewer can filter by some field or sort by some field it can read. */
  savedViews?: true;
  /**
   * The declared bulk actions. A bounded on-intent availability read decides each action's own
   * permission and precondition for the visible selection; execution rechecks current authority.
   */
  bulkActions?: readonly RecordsTableBulkActionContract[];
  /**
   * The fields the viewer may change on at least one row, each with how a cell edits it, and the
   * flow binding that commits a change.
   */
  inlineEdit?: Readonly<{ eventId: string; fields: readonly RecordsTableInlineEditField[] }>;
  /** Rows expand to their related records, read this many at a time. */
  masterDetail?: Readonly<{ pageSize: number }>;
  /** The styles the page's rows name and the numeric columns drawn as bars or scales. */
  conditionalFormatting?: ConditionalFormattingProjection;
  /**
   * The viewer can read the pivot's rows, columns and measure: it shows this many rows a page.
   * `view` is present when the address opens the table as a pivot, with its row position.
   */
  pivot?: Readonly<{ rowPageSize: number; totals: boolean; view?: Readonly<{ cursor?: string }> }>;
}>;

/**
 * How one cell edits one field, from the installed field definition alone: the control to draw and
 * the limits that stop obviously wrong input. It grants nothing; the protected writer validates
 * every value again. `required` says the field cannot be emptied.
 */
export type RecordsTableInlineEditor = Readonly<{ required: boolean }> &
  (
    | Readonly<{
        kind: "text";
        /** Which text control: a line, several lines, or an email, phone or web address. */
        input: "text" | "long_text" | "email" | "phone" | "web";
        maxLength?: number;
      }>
    | Readonly<{ kind: "whole_number"; minimum?: number; maximum?: number; step?: number }>
    | Readonly<{
        kind: "decimal";
        digitsBeforeDecimal: number;
        decimalPlaces: number;
        minimum?: string;
        maximum?: string;
      }>
    | Readonly<{ kind: "yes_no" }>
    | Readonly<{ kind: "choice"; options: readonly Readonly<{ value: string; label: string }>[] }>
    | Readonly<{ kind: "date"; earliest?: string; latest?: string }>
    | Readonly<{ kind: "date_time" }>
  );

/** One field a viewer may edit in a cell, as the field identity the table's columns use. */
export type RecordsTableInlineEditField = Readonly<{
  field: string;
  editor: RecordsTableInlineEditor;
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

/** Whether one row lets the viewer change this field now: the update action and the field's own policy. */
export const rowMayChangeField = (
  row: Pick<ProtectedQueryRow, "capabilities">,
  field: string,
): boolean =>
  row.capabilities?.actions.includes("update") === true &&
  row.capabilities.changeableFieldIds.some((fieldId) => sameField(fieldId, field));

/**
 * The inline-edit fields some row lets the viewer change now, which the viewer may read and the
 * installed definition describes an editor for; none when inline editing is off. The authored
 * allowlist only narrows what the definition and the viewer's access already allow.
 */
export const recordsTableEditableFields = (
  contract: RecordsTableContract,
  rows: readonly ProtectedQueryRow[],
  bounds: ProtectedQueryFieldBounds,
  editors: Readonly<Record<string, RecordsTableInlineEditor>> | undefined,
): readonly RecordsTableInlineEditField[] => {
  const inlineEdit = contract.features.inlineEdit;
  if (!inlineEdit.enabled || inlineEdit.eventId === undefined) return [];
  return inlineEdit.fields.flatMap((field): RecordsTableInlineEditField[] => {
    const editor = editors?.[field.toLowerCase()];
    return editor !== undefined &&
      bounds.readableFieldIds.some((fieldId) => sameField(fieldId, field)) &&
      rows.some((row) => rowMayChangeField(row, field))
      ? [{ field, editor }]
      : [];
  });
};

/** The one bulk-action projection; a disabled feature offers neither actions nor availability reads. */
export const recordsTableBulkActions = (
  contract: RecordsTableContract,
): readonly RecordsTableBulkActionContract[] =>
  contract.features.bulkActions.enabled ? contract.features.bulkActions.actions : [];

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
  pivotView?: Readonly<{ cursor?: string }>,
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
  const bulkActions = recordsTableBulkActions(contract);
  const inlineEdit = features.inlineEdit;
  const editableFields = recordsTableEditableFields(contract, rows, bounds, editors);
  // Every expanded row is read again under the viewer's current access: the projection only says
  // rows expand; a viewer who cannot read the related records sees the panel's neutral refusal.
  const masterDetail = features.masterDetail;
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
  const projection: RecordsTableFeatureProjection = {
    ...(features.spreadsheet.enabled &&
    typeof features.spreadsheet.rangeSelect === "boolean" &&
    typeof features.spreadsheet.find === "boolean" &&
    contract.columns.some((column) => readable(column.field))
      ? {
          spreadsheet: {
            rangeSelect: features.spreadsheet.rangeSelect,
            find: features.spreadsheet.find,
          },
        }
      : {}),
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
    ...(pivot === undefined ? {} : { pivot }),
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
