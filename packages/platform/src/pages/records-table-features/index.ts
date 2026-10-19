import type {
  RecordsTableActionContract,
  RecordsTableContract,
  RecordsTableFilterField,
} from "../../schema";
import type { ProtectedQueryRow } from "../../queries/protected-query-contracts";
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
 * viewer may do now. It is computed once per read, from the same rows and per-row capabilities the
 * Query engine decided under the viewer's current access and field policy, and travels in the
 * table payload; there is no separate request and nothing is cached. A feature that is off for the
 * viewer is absent, and a table with every feature off carries no projection at all.
 */
export type RecordsTableFeatureProjection = Readonly<{
  search?: true;
  /**
   * The filterable fields the viewer may filter by, each with its canonical type, filter kind and
   * what its control needs (choice options, a fixed currency, the organisation time zone).
   */
  columnFilters?: readonly RecordsTableFilterField[];
  savedViews?: true;
  /** The bulk commands at least one row of the page lets the viewer run. */
  bulkActions?: readonly RecordsTableActionContract[];
  /** The fields the viewer may change on at least one row, and the flow binding that commits a change. */
  inlineEdit?: Readonly<{ eventId: string; fields: readonly string[] }>;
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
  | "row_clicked";

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
 * Projects the enabled features for the viewer of one read. `visibleFieldIds` are the columns the
 * read requested; a requested column that every returned row withholds is a field the viewer may
 * not read, so it is not offered as a filter. `filterFields` describes each filterable field. A bulk command that names a capability is offered
 * when some row allows it, and inline editing keeps only fields some row lets the viewer change.
 * Every request a projected control makes is still re-checked by the server.
 */
export const projectRecordsTableFeatures = (
  contract: RecordsTableContract,
  visibleFieldIds: readonly string[],
  rows: readonly ProtectedQueryRow[],
  filterFields: Readonly<Record<string, RecordsTableFilterField>> | undefined,
  conditionalFormatting?: ConditionalFormattingProjection,
): RecordsTableFeatureProjection | undefined => {
  const { features } = contract;
  const withheld = (field: string): boolean =>
    rows.length > 0 &&
    visibleFieldIds.some((fieldId) => sameField(fieldId, field)) &&
    rows.every((row) => !Object.keys(row.values).some((key) => sameField(key, field)));
  // A declared filter field the installed definition gives no filter kind is not offered; the
  // server refuses a filter on it anyway.
  const columnFilters = features.columnFilters.enabled
    ? features.columnFilters.fields.flatMap((field) => {
        const described = filterFields?.[field.toLowerCase()];
        return described === undefined || withheld(field) ? [] : [described];
      })
    : [];
  const bulkActions = features.bulkActions.enabled
    ? features.bulkActions.actions.filter(
        (action) =>
          action.capability === undefined ||
          rows.some((row) => row.capabilities?.actions.includes(action.capability!) === true),
      )
    : [];
  const inlineEdit = features.inlineEdit;
  const editableFields =
    inlineEdit.enabled && inlineEdit.eventId !== undefined
      ? inlineEdit.fields.filter((field) =>
          rows.some(
            (row) =>
              row.capabilities?.actions.includes("update") === true &&
              row.capabilities.changeableFieldIds.some((fieldId) => sameField(fieldId, field)),
          ),
        )
      : [];
  const projection: RecordsTableFeatureProjection = {
    ...(features.search.enabled ? { search: true as const } : {}),
    ...(columnFilters.length === 0 ? {} : { columnFilters }),
    ...(features.savedViews.enabled ? { savedViews: true as const } : {}),
    ...(bulkActions.length === 0 ? {} : { bulkActions }),
    ...(editableFields.length === 0 || !inlineEdit.enabled || inlineEdit.eventId === undefined
      ? {}
      : { inlineEdit: { eventId: inlineEdit.eventId, fields: editableFields } }),
    ...(conditionalFormatting === undefined || !features.conditionalFormatting.enabled
      ? {}
      : { conditionalFormatting }),
  };
  return Object.keys(projection).length === 0 ? undefined : projection;
};
