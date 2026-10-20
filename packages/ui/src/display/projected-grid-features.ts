import {
  type RecordsTableBulkActionContract,
  type RecordsTableBulkRefusalReason,
  type RecordsTableFeatureProjection,
  type RecordsTableFilterField,
  type RecordsTableFilterValue,
  readRecordsTableFieldFilter,
  recordsTableBulkActionRecordLimit,
  recordsTableBulkRefusalReasons,
  recordsTableFilterKinds,
  RECORDS_TABLE_MAXIMUM_SEARCH_LENGTH,
} from "@vortex/platform/schema";
import { parseConditionalFormatting } from "./projected-format";
import type { DefinitionRenderErrorLocation } from "../definition-error";
import {
  fail,
  requireRecord,
  requireExactKeys,
  requireArray,
  requireFieldKey,
  requireNonEmptyString,
  type TableNarrowing,
} from "./projected-data";

/** The search and filters a table page was read with: a bounded search and one value per field. */
export const parseTableNarrowing = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): TableNarrowing => {
  const record = requireRecord(value, "Projected table narrowing is invalid", location);
  requireExactKeys(record, ["search", "filters", "recordTitles"], location);
  if (
    record.search !== null &&
    (typeof record.search !== "string" ||
      record.search.trim() === "" ||
      record.search.length > RECORDS_TABLE_MAXIMUM_SEARCH_LENGTH)
  )
    fail("A projected table search must be null or non-empty bounded text", location);
  const items = requireArray(record.filters, "Projected table filters must be an array", location);
  const filters = items.map((item): RecordsTableFilterValue => {
    const filter = requireRecord(item, "A projected table filter must be an object", location);
    requireExactKeys(filter, ["fieldId", "filter"], location);
    const fieldId = requireFieldKey(
      filter.fieldId,
      "A projected table filter requires a field",
      location,
    );
    const typed = readRecordsTableFieldFilter(filter.filter);
    if (typed === undefined) fail("A projected table filter is not a valid typed filter", location);
    return Object.freeze({ fieldId, filter: typed! });
  });
  if (new Set(filters.map((filter) => filter.fieldId.toLowerCase())).size !== filters.length)
    fail("A projected table narrowing names each filtered field once", location);
  let recordTitles: Record<string, string> | undefined;
  if (record.recordTitles !== undefined) {
    const titles = requireRecord(
      record.recordTitles,
      "Projected filter titles are invalid",
      location,
    );
    recordTitles = Object.fromEntries(
      Object.entries(titles).map(([recordId, title]) => [
        recordId,
        requireNonEmptyString(title, "A projected filter title must be text", location),
      ]),
    );
  }
  return Object.freeze({
    search: record.search as string | null,
    filters: Object.freeze(filters),
    ...(recordTitles === undefined ? {} : { recordTitles: Object.freeze(recordTitles) }),
  });
};

/** One projected bulk action: the named action's key, its label, confirmation and record limit. */
const parseTableAction = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): RecordsTableBulkActionContract => {
  const action = requireRecord(value, "A projected bulk action must be an object", location);
  requireExactKeys(action, ["action", "label", "confirm", "maxRecords"], location);
  const key = requireNonEmptyString(action.action, "A bulk action needs its action", location);
  const label = requireNonEmptyString(action.label, "A bulk action needs its label", location);
  if (typeof action.confirm !== "boolean")
    fail("A bulk action must say if it asks first", location);
  if (
    typeof action.maxRecords !== "number" ||
    !Number.isInteger(action.maxRecords) ||
    action.maxRecords < 1 ||
    action.maxRecords > recordsTableBulkActionRecordLimit
  )
    fail("A bulk action has an invalid record limit", location);
  return Object.freeze({
    action: key,
    label,
    confirm: action.confirm as boolean,
    maxRecords: action.maxRecords as number,
  });
};

/**
 * How far a Records table selection reaches beyond the shown page, as the page runtime holds it:
 * the count of every matching record is being read, every matching record is selected (minus the
 * records the person unticked), or the matching records could not be counted.
 */
export type TableSelectionScope =
  | Readonly<{ kind: "counting" }>
  | Readonly<{ kind: "matching"; count: number; excluded: number }>
  | Readonly<{ kind: "not_counted"; reason: "too_many" | "search_not_counted" | "unavailable" }>;

/** What a finished bulk run reports: the records it covered, changed, refused and did not reach. */
export type TableBulkRunSummary = Readonly<{
  total: number;
  done: number;
  refused: readonly Readonly<{ reason: RecordsTableBulkRefusalReason; count: number }>[];
  notProcessed: number;
  limited: boolean;
}>;

/** One bulk run of a table, as the page runtime follows it: running, finished or failed. */
export type TableBulkRun =
  | Readonly<{ status: "running"; label: string; total?: number; processed: number }>
  | Readonly<{ status: "finished"; label: string; selected: number; summary: TableBulkRunSummary }>
  | Readonly<{ status: "failed"; label: string }>;

/**
 * The selection parts of a table payload: the server's sealed descriptor of every matching record
 * of the read, and the selection scope and bulk run the page runtime adds.
 */
export type TableSelectionParts = Readonly<{
  selectionToken?: string;
  selectionScope?: TableSelectionScope;
  bulkRun?: TableBulkRun;
}>;

const wholeCount = (value: unknown, location: DefinitionRenderErrorLocation): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    fail("A selection count must be a whole number", location);
  return value as number;
};

const parseSelectionScope = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): TableSelectionScope => {
  const scope = requireRecord(value, "A table selection scope is invalid", location);
  if (scope.kind === "counting") return Object.freeze({ kind: "counting" });
  if (scope.kind === "matching")
    return Object.freeze({
      kind: "matching",
      count: wholeCount(scope.count, location),
      excluded: wholeCount(scope.excluded, location),
    });
  if (
    scope.kind === "not_counted" &&
    (scope.reason === "too_many" ||
      scope.reason === "search_not_counted" ||
      scope.reason === "unavailable")
  )
    return Object.freeze({ kind: "not_counted", reason: scope.reason });
  return fail("A table selection scope is invalid", location);
};

const parseBulkRun = (value: unknown, location: DefinitionRenderErrorLocation): TableBulkRun => {
  const run = requireRecord(value, "A table bulk run is invalid", location);
  const label = requireNonEmptyString(run.label, "A table bulk run needs its label", location);
  if (run.status === "failed") return Object.freeze({ status: "failed", label });
  if (run.status === "running")
    return Object.freeze({
      status: "running",
      label,
      ...(run.total === undefined ? {} : { total: wholeCount(run.total, location) }),
      processed: wholeCount(run.processed, location),
    });
  if (run.status !== "finished") return fail("A table bulk run is invalid", location);
  const summary = requireRecord(run.summary, "A bulk run summary is invalid", location);
  return Object.freeze({
    status: "finished",
    label,
    selected: wholeCount(run.selected, location),
    summary: Object.freeze({
      total: wholeCount(summary.total, location),
      done: wholeCount(summary.done, location),
      refused: Object.freeze(
        requireArray(summary.refused, "Bulk run refusals are invalid", location).map((item) => {
          const refusal = requireRecord(item, "A bulk run refusal is invalid", location);
          if (!(recordsTableBulkRefusalReasons as readonly unknown[]).includes(refusal.reason))
            fail("A bulk run refusal names an unknown reason", location);
          return Object.freeze({
            reason: refusal.reason as RecordsTableBulkRefusalReason,
            count: wholeCount(refusal.count, location),
          });
        }),
      ),
      notProcessed: wholeCount(summary.notProcessed, location),
      limited: summary.limited === true,
    }),
  });
};

/** The selection parts of a projected table payload; each is absent unless present. */
export const parseTableSelectionParts = (
  record: Readonly<Record<string, unknown>>,
  location: DefinitionRenderErrorLocation,
): TableSelectionParts => {
  const token = record.selectionToken;
  if (token !== undefined && (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,65536}$/.test(token)))
    fail("A table selection token is invalid", location);
  return Object.freeze({
    ...(token === undefined ? {} : { selectionToken: token as string }),
    ...(record.selectionScope === undefined
      ? {}
      : { selectionScope: parseSelectionScope(record.selectionScope, location) }),
    ...(record.bulkRun === undefined ? {} : { bulkRun: parseBulkRun(record.bulkRun, location) }),
  });
};

const parseFieldKeys = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): readonly string[] => {
  const fields = requireArray(value, message, location).map((field) =>
    requireFieldKey(field, message, location),
  );
  if (
    fields.length === 0 ||
    new Set(fields.map((field) => field.toLowerCase())).size !== fields.length
  )
    fail(message, location);
  return Object.freeze(fields);
};

/** One projected filterable field: its identity, label, canonical type, filter kind and control facts. */
const parseFilterField = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): RecordsTableFilterField => {
  const message = "A projected filter field is invalid";
  const field = requireRecord(value, message, location);
  requireExactKeys(
    field,
    ["fieldId", "label", "type", "kind", "options", "currency", "timeZone"],
    location,
  );
  if (!(recordsTableFilterKinds as readonly unknown[]).includes(field.kind))
    fail(message, location);
  const options =
    field.options === undefined
      ? undefined
      : requireArray(field.options, message, location).map((option) => {
          const held = requireRecord(option, message, location);
          requireExactKeys(held, ["value", "label"], location);
          return Object.freeze({
            value: requireNonEmptyString(held.value, message, location),
            label: requireNonEmptyString(held.label, message, location),
          });
        });
  if ((field.kind === "choice") !== (options !== undefined)) fail(message, location);
  return Object.freeze({
    fieldId: requireFieldKey(field.fieldId, message, location),
    label: requireNonEmptyString(field.label, message, location),
    type: requireNonEmptyString(field.type, message, location),
    kind: field.kind as RecordsTableFilterField["kind"],
    ...(options === undefined ? {} : { options: Object.freeze(options) }),
    ...(field.currency === undefined
      ? {}
      : { currency: requireNonEmptyString(field.currency, message, location) }),
    ...(field.timeZone === undefined
      ? {}
      : { timeZone: requireNonEmptyString(field.timeZone, message, location) }),
  });
};

/** The grid features the server projected for the viewer: each present feature is on. */
export const parseTableFeatures = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): RecordsTableFeatureProjection => {
  const record = requireRecord(value, "Projected table features are invalid", location);
  requireExactKeys(
    record,
    ["search", "columnFilters", "savedViews", "bulkActions", "inlineEdit", "conditionalFormatting"],
    location,
  );
  if (Object.keys(record).length === 0) fail("Projected table features name no feature", location);
  if (record.search !== undefined && record.search !== true)
    fail("A projected search feature is only ever on", location);
  if (record.savedViews !== undefined && record.savedViews !== true)
    fail("A projected saved views feature is only ever on", location);
  const columnFilters =
    record.columnFilters === undefined
      ? undefined
      : Object.freeze(
          requireArray(record.columnFilters, "Projected filter fields are invalid", location).map(
            (field) => parseFilterField(field, location),
          ),
        );
  if (
    columnFilters !== undefined &&
    (columnFilters.length === 0 ||
      new Set(columnFilters.map((field) => field.fieldId.toLowerCase())).size !==
        columnFilters.length)
  )
    fail("Projected filter fields are invalid", location);
  const bulkActions =
    record.bulkActions === undefined
      ? undefined
      : requireArray(record.bulkActions, "Projected bulk actions are invalid", location).map(
          (action) => parseTableAction(action, location),
        );
  if (bulkActions !== undefined && bulkActions.length === 0)
    fail("Projected bulk actions are empty", location);
  let inlineEdit: RecordsTableFeatureProjection["inlineEdit"];
  if (record.inlineEdit !== undefined) {
    const inline = requireRecord(
      record.inlineEdit,
      "Projected inline editing is invalid",
      location,
    );
    requireExactKeys(inline, ["eventId", "fields"], location);
    inlineEdit = Object.freeze({
      eventId: requireNonEmptyString(inline.eventId, "Inline editing needs its event", location),
      fields: parseFieldKeys(inline.fields, "Projected editable fields are invalid", location),
    });
  }
  return Object.freeze({
    ...(record.search === true ? { search: true as const } : {}),
    ...(columnFilters === undefined ? {} : { columnFilters }),
    ...(record.savedViews === true ? { savedViews: true as const } : {}),
    ...(bulkActions === undefined ? {} : { bulkActions: Object.freeze(bulkActions) }),
    ...(inlineEdit === undefined ? {} : { inlineEdit }),
    ...(record.conditionalFormatting === undefined
      ? {}
      : {
          conditionalFormatting: parseConditionalFormatting(record.conditionalFormatting, location),
        }),
  });
};
