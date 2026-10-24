import type {
  ConditionalFormattingProjection,
  RecordsTableBulkActionContract,
  RecordsTableContract,
  RecordsTableFeatureProjection,
  RecordsTableFilterField,
  RecordsTableInlineEditField,
  RecordsTableInlineEditor,
  RecordsTablePivotView,
} from "../../schema";
import type {
  ProtectedQueryFieldBounds,
  ProtectedQueryRow,
} from "../../queries/protected-query-contracts";

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
  return projectedEditableFields(contract.features.inlineEdit, rows, bounds, editors);
};

const projectedEditableFields = (
  feature:
    RecordsTableContract["features"]["inlineEdit"] | RecordsTableContract["features"]["rowEdit"],
  rows: readonly ProtectedQueryRow[],
  bounds: ProtectedQueryFieldBounds,
  editors: Readonly<Record<string, RecordsTableInlineEditor>> | undefined,
): readonly RecordsTableInlineEditField[] => {
  if (!feature.enabled || feature.eventId === undefined) return [];
  return feature.fields.flatMap((field): RecordsTableInlineEditField[] => {
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
 * The row actions a table offers and, per row, whether the capabilities its read decided make each
 * eligible; absent when the feature is off or the table declares none. Named-action eligibility is
 * decided afterwards, in the read's own request, by `projectRowActionAvailability`.
 */
export const recordsTableRowActionsProjection = (
  contract: RecordsTableContract,
  rows: readonly ProtectedQueryRow[],
): RecordsTableFeatureProjection["rowActions"] =>
  contract.features.rowActions.enabled && contract.rowBehaviours.rowActions.length > 0
    ? {
        actions: contract.rowBehaviours.rowActions,
        availability: rows.flatMap((row) =>
          row.revision === undefined
            ? []
            : [
                {
                  recordId: row.recordId,
                  revision: row.revision,
                  actions: contract.rowBehaviours.rowActions.map((action) =>
                    action.capability === undefined ||
                    row.capabilities?.actions.includes(action.capability) === true
                      ? { action: action.eventId, eligible: true as const }
                      : {
                          action: action.eventId,
                          eligible: false as const,
                          reason: "not_permitted" as const,
                        },
                  ),
                },
              ],
        ),
      }
    : undefined;

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
  const rowEdit = features.rowEdit;
  const rowFields = projectedEditableFields(rowEdit, rows, bounds, editors);
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
  const exportSettings = features.export;
  // A status bar total names only fields the table shows as columns; with none left it is omitted.
  const statusBarFields = features.spreadsheet.enabled
    ? features.spreadsheet.statusBarFields.filter((field) =>
        contract.columns.some((column) => sameField(column.field, field)),
      )
    : [];
  const batchEditable =
    features.spreadsheet.enabled &&
    features.spreadsheet.rangeSelect === true &&
    editableFields.length > 0 &&
    inlineEdit.enabled &&
    inlineEdit.eventId !== undefined;
  const pasteUsable =
    batchEditable && features.spreadsheet.enabled && features.spreadsheet.paste === true;
  const fillUsable =
    batchEditable && features.spreadsheet.enabled && features.spreadsheet.fill === true;
  const undoUsable =
    (pasteUsable || fillUsable) &&
    features.spreadsheet.enabled &&
    features.spreadsheet.undo === true;
  const rowActions = recordsTableRowActionsProjection(contract, rows);
  const projection: RecordsTableFeatureProjection = {
    ...(exportSettings.enabled &&
    exportAllowed === true &&
    exportSettings.maxRows !== undefined &&
    exportSettings.formats.length > 0 &&
    contract.columns.some((column) => readable(column.field))
      ? { export: { maxRows: exportSettings.maxRows, formats: exportSettings.formats } }
      : {}),
    ...(rowEdit.enabled &&
    rowEdit.eventId !== undefined &&
    rowEdit.trigger === "button" &&
    rowFields.length > 0
      ? { rowEdit: { eventId: rowEdit.eventId, trigger: rowEdit.trigger, fields: rowFields } }
      : {}),
    ...(features.spreadsheet.enabled &&
    typeof features.spreadsheet.rangeSelect === "boolean" &&
    typeof features.spreadsheet.find === "boolean" &&
    contract.columns.some((column) => readable(column.field))
      ? {
          spreadsheet: {
            rangeSelect: features.spreadsheet.rangeSelect,
            find: features.spreadsheet.find,
            ...(pasteUsable ? { paste: true as const } : {}),
            ...(fillUsable ? { fill: true as const } : {}),
            ...(undoUsable ? { undo: true as const } : {}),
            ...(features.spreadsheet.rangeSelect &&
            statusBarFields.length > 0 &&
            features.spreadsheet.statusBarOperations.length > 0
              ? {
                  statusBar: {
                    fields: statusBarFields,
                    operations: features.spreadsheet.statusBarOperations,
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(rowActions === undefined ? {} : { rowActions }),
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
    // A tree needs the parent link among the fields the viewer is guaranteed to see.
    ...(tree.enabled &&
    tree.childPageSize !== undefined &&
    tree.parentField !== undefined &&
    readable(tree.parentField)
      ? { tree: { pageSize: tree.childPageSize } }
      : {}),
    ...(grouping === undefined || grouping.label === "" ? {} : { grouping }),
    ...(conditionalFormatting === undefined || !features.conditionalFormatting.enabled
      ? {}
      : { conditionalFormatting }),
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
