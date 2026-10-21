import type {
  NamedActionAvailability,
  RecordsTableActionContract,
  RecordsTableBulkActionContract,
  RecordsTableContract,
  RecordsTableFilterField,
  RecordsTableExportFormat,
  RecordsTableStatusBarOperation,
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
  personalFormattingAllowed,
  personalFormattingRules,
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
  spreadsheet?: Readonly<{
    rangeSelect: boolean;
    find: boolean;
    /** Paste, fill down and undo of batches; each is present only when usable now. */
    paste?: true;
    fill?: true;
    undo?: true;
    /**
     * The status bar of a selected range: the configured fields (every one is shown, a field the
     * viewer cannot read as "Not available") and the totals. Absent while the status bar is off.
     */
    statusBar?: Readonly<{
      fields: readonly string[];
      operations: readonly RecordsTableStatusBarOperation[];
    }>;
  }>;
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
  rowActions?: Readonly<{
    actions: readonly RecordsTableActionContract[];
    availability: NamedActionAvailability;
  }>;
  /**
   * The fields the viewer may change on at least one row, each with how a cell edits it, and the
   * flow binding that commits a change.
   */
  inlineEdit?: Readonly<{ eventId: string; fields: readonly RecordsTableInlineEditField[] }>;
  rowEdit?: Readonly<{
    eventId: string;
    trigger: "button";
    fields: readonly RecordsTableInlineEditField[];
  }>;
  /** Rows expand to their related records, read this many at a time. */
  masterDetail?: Readonly<{ pageSize: number }>;
  /** Rows expand to the records that name them as their parent, read this many at a time. */
  tree?: Readonly<{ pageSize: number }>;
  /**
   * The viewer may group the table by the authored choice field: it is readable on every record
   * the viewer may read, so the grouped read never needs a withheld value.
   */
  grouping?: Readonly<{
    fieldId: string;
    label: string;
    unassignedLabel: string;
    /** The authored opening state: the address overrides it (grouped or flat) for this viewer. */
    opensGrouped: boolean;
    /** The table reads a grouped query, so it is always grouped and offers no way to ungroup. */
    required?: true;
  }>;
  /** The styles the page's rows name and the numeric columns drawn as bars or scales. */
  conditionalFormatting?: ConditionalFormattingProjection;
  /**
   * The viewer can read the pivot's rows, columns and measure: it shows this many rows a page.
   * `view` is present when the address opens the table as a pivot, with its row position.
   */
  pivot?: Readonly<{ rowPageSize: number; totals: boolean; view?: Readonly<{ cursor?: string }> }>;
  /**
   * The viewer may export the records they see: the most records one export holds. Present only
   * when the feature is on and the viewer's export permission allowed it in this read; the export
   * route decides both again on every request.
   */
  export?: Readonly<{ maxRows: number; formats: readonly RecordsTableExportFormat[] }>;
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
    | Readonly<{
        kind: "choice";
        options: readonly Readonly<{
          value: string;
          label: string;
          parentValues?: readonly string[];
        }>[];
        /**
         * The choice field of the same record type whose chosen option narrows this field's
         * options, as the table's field identity (lower case): only options listing that parent
         * option are offered, and changing the parent must clear or flag this field.
         */
        dependsOnField?: string;
      }>
    | Readonly<{ kind: "date"; earliest?: string; latest?: string }>
    | Readonly<{ kind: "date_time" }>
    | Readonly<{
        /** A single-target link: the person picks one record of the installed target type. */
        kind: "link";
        recordTypeId: string;
        targetLabel: string;
        /**
         * The link field of the same record type whose chosen record narrows this field's choices,
         * as the table's field identity (lower case). The picker offers this field's records only
         * for that parent, and changing the parent must clear or flag this field.
         */
        dependsOnField?: string;
      }>
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
    ...(features.rowActions.enabled && contract.rowBehaviours.rowActions.length > 0
      ? {
          rowActions: {
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
