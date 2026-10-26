import { recordsTableTotalsSchema, type RecordsTableTotal } from "@vortex/platform/schema";
import {
  type RecordsTableBulkRefusalReason,
  type RecordsTableExportFormat,
  type RecordsTableFilterValue,
  readRecordsTableFieldFilter,
  recordsTableBulkRunLineSchema,
  recordsSelectionMaximumIds,
  RECORDS_TABLE_MAXIMUM_SEARCH_LENGTH,
  namedActionAvailabilitySchema,
  type NamedActionAvailability,
} from "@vortex/platform/schema";
import type { DefinitionRenderErrorLocation } from "../definition-error";
import {
  fail,
  requireRecord,
  requireExactKeys,
  requireArray,
  requireFieldKey,
  requireNonEmptyString,
} from "./payload-parse";
import type { TableNarrowing } from "./projected-data";

/** The table's gestures over its explicit selection or sealed matching scope. */
export type TableSelectionEvent =
  | Readonly<{
      event: "selection_changed";
      recordId: string;
      /** The drawn row's revision, held until it is deselected. */
      revision: number;
      selected: boolean;
    }>
  /** Runs a declared bulk named action over the selection the page holds for the table. */
  | Readonly<{ event: "bulk_action"; action: string }>
  /** Widens the selection to every matching record, or clears it (and a finished run's summary). */
  | Readonly<{ event: "selection_scope_changed"; scope: "matching" | "cleared" }>
  /** Downloads the rows ticked on the page, the records of the current view, or every matching record. */
  | Readonly<{
      event: "export_requested";
      scope: "selected" | "view" | "matching";
      format: RecordsTableExportFormat;
    }>
  /** Stops the export in progress; no file is saved. */
  | Readonly<{ event: "export_cancelled" }>;

export const parseSelectedRecordIds = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): readonly string[] | undefined => {
  if (value === undefined) return undefined;
  const items = requireArray(value, "Selected record identities must be an array", location);
  if (items.length > recordsSelectionMaximumIds)
    fail(`Select at most ${recordsSelectionMaximumIds} records`, location);
  // Held selections can name a previously drawn row beneath a closed branch.
  const seen = new Set<string>();
  return Object.freeze(
    items.map((item) => {
      const recordId = requireNonEmptyString(
        item,
        "A selected record identity must be a non-empty string",
        location,
      );
      if (seen.has(recordId)) fail(`Duplicate selected record identity '${recordId}'`, location);
      seen.add(recordId);
      return recordId;
    }),
  );
};

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

/**
 * How far a Records table selection reaches beyond the shown page, as the page runtime holds it:
 * the count of every matching record is being read, every matching record is selected (minus the
 * records the person unticked), or the matching records could not be counted.
 */
export type TableSelectionScope =
  | Readonly<{ kind: "counting" }>
  | Readonly<{ kind: "matching"; count: number; excluded: number }>
  | Readonly<{ kind: "not_counted"; reason: "too_many" | "changed" | "unavailable" }>;

/** What a finished bulk run reports: the records it covered, changed, refused and did not reach. */
export type TableBulkRunSummary = Readonly<{
  total: number;
  done: number;
  warnings: readonly Readonly<{ message: string; count: number }>[];
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
 * One export of a table, as the page runtime follows it. `running` is a file being received (the
 * bytes so far); `finished` is a whole file the person has; `refused` is a message instead of a
 * file; `incomplete` is a file that stopped short, which is never saved; `cancelled` is the
 * person's own stop. The run ID stays the same through progress and outcome, including when
 * the page payload is parsed again.
 */
export type TableExportRun =
  | Readonly<{
      runId: string;
      status: "running";
      scope: TableExportScope;
      expected?: number;
      bytes: number;
    }>
  | Readonly<{ runId: string; status: "finished"; scope: TableExportScope; filename: string }>
  | Readonly<{ runId: string; status: "refused"; message: string }>
  | Readonly<{ runId: string; status: "incomplete" }>
  | Readonly<{ runId: string; status: "cancelled" }>;

/** What an export covers: the rows ticked on the page, the current view, or every matching record. */
export type TableExportScope = "selected" | "view" | "matching";

/**
 * The selection parts of a table payload: the server's sealed descriptor of every matching record
 * of the read, and the selection scope, bulk run and export the page runtime adds.
 */
export type TableSelectionParts = Readonly<{
  selectionToken?: string;
  selectionScope?: TableSelectionScope;
  bulkRun?: TableBulkRun;
  exportRun?: TableExportRun;
  actionAvailability?: NamedActionAvailability | "unavailable";
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
    (scope.reason === "too_many" || scope.reason === "changed" || scope.reason === "unavailable")
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
  const parsed = recordsTableBulkRunLineSchema.safeParse({ ...summary, kind: "summary" });
  if (!parsed.success || parsed.data.kind !== "summary")
    return fail("A bulk run summary is invalid", location);
  const finished = parsed.data;
  return Object.freeze({
    status: "finished",
    label,
    selected: wholeCount(run.selected, location),
    summary: Object.freeze({
      total: finished.total,
      done: finished.done,
      warnings: Object.freeze(finished.warnings),
      refused: Object.freeze(finished.refused),
      notProcessed: finished.notProcessed,
      limited: finished.limited,
    }),
  });
};

const parseExportRun = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): TableExportRun => {
  const run = requireRecord(value, "A table export is invalid", location);
  const runId = requireNonEmptyString(run.runId, "A table export needs its run ID", location);
  const scope = (): TableExportScope => {
    if (run.scope !== "selected" && run.scope !== "view" && run.scope !== "matching")
      fail("A table export names an unknown scope", location);
    return run.scope as TableExportScope;
  };
  switch (run.status) {
    case "running":
      return Object.freeze({
        status: "running",
        runId,
        scope: scope(),
        bytes: wholeCount(run.bytes, location),
        ...(run.expected === undefined ? {} : { expected: wholeCount(run.expected, location) }),
      });
    case "finished":
      return Object.freeze({
        status: "finished",
        runId,
        scope: scope(),
        filename: requireNonEmptyString(run.filename, "A finished export needs its file", location),
      });
    case "refused":
      return Object.freeze({
        status: "refused",
        runId,
        message: requireNonEmptyString(run.message, "A refused export needs its message", location),
      });
    case "incomplete":
    case "cancelled":
      return Object.freeze({ status: run.status, runId });
    default:
      return fail("A table export has an unknown status", location);
  }
};

/** The selection parts of a projected table payload; each is absent unless present. */
export const parseTableSelectionParts = (
  record: Readonly<Record<string, unknown>>,
  location: DefinitionRenderErrorLocation,
): TableSelectionParts => {
  const token = record.selectionToken;
  const availability =
    record.actionAvailability === undefined || record.actionAvailability === "unavailable"
      ? undefined
      : namedActionAvailabilitySchema.safeParse(record.actionAvailability);
  if (availability !== undefined && !availability.success)
    fail("Projected named action availability is invalid", location);
  if (token !== undefined && (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,65536}$/.test(token)))
    fail("A table selection token is invalid", location);
  return Object.freeze({
    ...(token === undefined ? {} : { selectionToken: token as string }),
    ...(record.selectionScope === undefined
      ? {}
      : { selectionScope: parseSelectionScope(record.selectionScope, location) }),
    ...(record.bulkRun === undefined ? {} : { bulkRun: parseBulkRun(record.bulkRun, location) }),
    ...(record.exportRun === undefined
      ? {}
      : { exportRun: parseExportRun(record.exportRun, location) }),
    ...(availability?.success === true ? { actionAvailability: availability.data } : {}),
    ...(record.actionAvailability === "unavailable"
      ? { actionAvailability: "unavailable" as const }
      : {}),
  });
};

/** One group of a grouped table: its key, its label and how many records it holds right now. */
export type TableGroup = Readonly<{
  key: string;
  label: string;
  count: number;
  totals?: readonly RecordsTableTotal[];
  unassigned?: true;
}>;

/**
 * The groups a grouped table was read with: one bounded count per group from the same read as the
 * table's filters and search, or the statement that there are too many filtered records to count
 * them in groups. The open group's key is one of the groups. The groups continue in pages: `page`
 * says whether this is the first and where the next one starts.
 */
export type TableGroups =
  | Readonly<{
      status: "ready";
      fieldId: string;
      groups: readonly TableGroup[];
      total: number;
      expanded?: string;
      /** Where this page of groups sits: the first one, and the opaque position of the next page. */
      page: Readonly<{ first: boolean; next?: string }>;
    }>
  | Readonly<{ status: "too_many" }>;

export const parseTableGroups = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): TableGroups => {
  const record = requireRecord(value, "Projected groups are invalid", location);
  if (record.status === "too_many") {
    requireExactKeys(record, ["status"], location);
    return Object.freeze({ status: "too_many" as const });
  }
  if (record.status !== "ready") return fail("Projected groups need a status", location);
  requireExactKeys(record, ["status", "fieldId", "groups", "total", "expanded", "page"], location);
  const position = requireRecord(record.page, "Projected groups need their page", location);
  requireExactKeys(position, ["first", "next"], location);
  if (typeof position.first !== "boolean")
    fail("A group page says whether it is the first", location);
  const next =
    position.next === undefined
      ? undefined
      : requireNonEmptyString(position.next, "The next group page needs its position", location);
  const groups = requireArray(record.groups, "Projected groups must be an array", location).map(
    (item): TableGroup => {
      const group = requireRecord(item, "A projected group must be an object", location);
      requireExactKeys(group, ["key", "label", "count", "unassigned", "totals"], location);
      if (group.unassigned !== undefined && group.unassigned !== true)
        fail("A projected group is only ever unassigned", location);
      if (typeof group.count !== "number" || !Number.isInteger(group.count) || group.count < 0)
        fail("A projected group count must be a whole number", location);
      return Object.freeze({
        key: requireNonEmptyString(group.key, "A projected group needs its key", location),
        label: requireNonEmptyString(group.label, "A projected group needs its label", location),
        count: group.count as number,
        ...(group.totals === undefined
          ? {}
          : {
              totals: (() => {
                const parsed = recordsTableTotalsSchema.safeParse(group.totals);
                if (!parsed.success) return fail("Projected group totals are invalid", location);
                return parsed.data;
              })(),
            }),
        ...(group.unassigned === true ? { unassigned: true as const } : {}),
      });
    },
  );
  if (new Set(groups.map((group) => group.key)).size !== groups.length)
    fail("Projected groups name each group once", location);
  if (typeof record.total !== "number" || !Number.isInteger(record.total) || record.total < 0)
    fail("Projected groups need their total", location);
  const expanded =
    record.expanded === undefined
      ? undefined
      : requireNonEmptyString(record.expanded, "The open group must be named by its key", location);
  if (expanded !== undefined && !groups.some((group) => group.key === expanded))
    fail("The open group must be one of the groups", location);
  return Object.freeze({
    status: "ready" as const,
    fieldId: requireNonEmptyString(record.fieldId, "Projected groups need their field", location),
    groups: Object.freeze(groups),
    total: record.total as number,
    ...(expanded === undefined ? {} : { expanded }),
    page: Object.freeze({
      first: position.first as boolean,
      ...(next === undefined ? {} : { next }),
    }),
  });
};
