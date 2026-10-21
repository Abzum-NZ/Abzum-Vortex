import {
  recordsTableRowActionIcons,
  recordsTableActionCapabilities,
  type RecordsTableActionContract,
  type RecordsTableInlineEditField,
  type RecordsTableInlineEditor,
  type RecordsTableBulkActionContract,
  type RecordsTableBulkRefusalReason,
  type RecordsTableExportFormat,
  type RecordsTableFeatureProjection,
  type RecordsTableFilterField,
  type RecordsTableFilterValue,
  readRecordsTableFieldFilter,
  recordsTableBulkActionRecordLimit,
  recordsTableBulkRunLineSchema,
  recordsSelectionMaximumIds,
  recordsTableFilterKinds,
  RECORDS_TABLE_EXPORT_MAXIMUM_ROWS,
  recordsTableExportFormats,
  RECORDS_TABLE_MAXIMUM_SEARCH_LENGTH,
  RECORDS_TABLE_STATUS_BAR_MAXIMUM_FIELDS,
  recordsTableStatusBarOperations,
  type RecordsTableStatusBarOperation,
  namedActionAvailabilitySchema,
  type NamedActionAvailability,
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
  requirePositiveInteger,
  type TableNarrowing,
} from "./projected-data";

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

const optionalText = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string | undefined =>
  value === undefined ? undefined : requireNonEmptyString(value, message, location);

const optionalInteger = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(message, location);
  return value as number;
};

/** The closed editor description of one editable field; any other shape is refused whole. */
const parseInlineEditor = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): RecordsTableInlineEditor => {
  const message = "A projected cell editor is invalid";
  const editor = requireRecord(value, message, location);
  if (typeof editor.required !== "boolean") fail(message, location);
  const required = editor.required as boolean;
  switch (editor.kind) {
    case "text": {
      requireExactKeys(editor, ["kind", "required", "input", "maxLength"], location);
      if (!["text", "long_text", "email", "phone", "web"].includes(editor.input as string))
        fail(message, location);
      const maxLength = optionalInteger(editor.maxLength, message, location);
      return Object.freeze({
        kind: "text",
        required,
        input: editor.input as "text" | "long_text" | "email" | "phone" | "web",
        ...(maxLength === undefined ? {} : { maxLength }),
      });
    }
    case "whole_number": {
      requireExactKeys(editor, ["kind", "required", "minimum", "maximum", "step"], location);
      const minimum = optionalInteger(editor.minimum, message, location);
      const maximum = optionalInteger(editor.maximum, message, location);
      const step = optionalInteger(editor.step, message, location);
      return Object.freeze({
        kind: "whole_number",
        required,
        ...(minimum === undefined ? {} : { minimum }),
        ...(maximum === undefined ? {} : { maximum }),
        ...(step === undefined ? {} : { step }),
      });
    }
    case "decimal": {
      requireExactKeys(
        editor,
        ["kind", "required", "digitsBeforeDecimal", "decimalPlaces", "minimum", "maximum"],
        location,
      );
      const digitsBeforeDecimal = optionalInteger(editor.digitsBeforeDecimal, message, location);
      const decimalPlaces = optionalInteger(editor.decimalPlaces, message, location);
      if (digitsBeforeDecimal === undefined || decimalPlaces === undefined) fail(message, location);
      const minimum = optionalText(editor.minimum, message, location);
      const maximum = optionalText(editor.maximum, message, location);
      return Object.freeze({
        kind: "decimal",
        required,
        digitsBeforeDecimal: digitsBeforeDecimal as number,
        decimalPlaces: decimalPlaces as number,
        ...(minimum === undefined ? {} : { minimum }),
        ...(maximum === undefined ? {} : { maximum }),
      });
    }
    case "yes_no":
      requireExactKeys(editor, ["kind", "required"], location);
      return Object.freeze({ kind: "yes_no", required });
    case "choice": {
      requireExactKeys(editor, ["kind", "required", "options", "dependsOnField"], location);
      const options = requireArray(editor.options, message, location).map((option) => {
        const entry = requireRecord(option, message, location);
        requireExactKeys(entry, ["value", "label", "parentValues"], location);
        return Object.freeze({
          value: requireNonEmptyString(entry.value, message, location),
          label: requireNonEmptyString(entry.label, message, location),
          ...(entry.parentValues === undefined
            ? {}
            : {
                parentValues: Object.freeze(
                  requireArray(entry.parentValues, message, location).map((parent) =>
                    requireNonEmptyString(parent, message, location),
                  ),
                ),
              }),
        });
      });
      if (options.length === 0) fail(message, location);
      // A dependent choice carries which parent options each option belongs to, and only it does.
      if (
        (editor.dependsOnField === undefined) !==
        options.every((option) => option.parentValues === undefined)
      )
        fail(message, location);
      return Object.freeze({
        kind: "choice",
        required,
        options: Object.freeze(options),
        ...(editor.dependsOnField === undefined
          ? {}
          : { dependsOnField: requireFieldKey(editor.dependsOnField, message, location) }),
      });
    }
    case "date": {
      requireExactKeys(editor, ["kind", "required", "earliest", "latest"], location);
      const earliest = optionalText(editor.earliest, message, location);
      const latest = optionalText(editor.latest, message, location);
      return Object.freeze({
        kind: "date",
        required,
        ...(earliest === undefined ? {} : { earliest }),
        ...(latest === undefined ? {} : { latest }),
      });
    }
    case "date_time":
      requireExactKeys(editor, ["kind", "required"], location);
      return Object.freeze({ kind: "date_time", required });
    case "link":
      requireExactKeys(
        editor,
        ["kind", "required", "recordTypeId", "targetLabel", "dependsOnField"],
        location,
      );
      return Object.freeze({
        kind: "link",
        required,
        recordTypeId: requireFieldKey(editor.recordTypeId, message, location),
        targetLabel: requireNonEmptyString(editor.targetLabel, message, location),
        ...(editor.dependsOnField === undefined
          ? {}
          : { dependsOnField: requireFieldKey(editor.dependsOnField, message, location) }),
      });
    default:
      return fail(message, location);
  }
};

const parseInlineEditFields = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): readonly RecordsTableInlineEditField[] => {
  const message = "Projected editable fields are invalid";
  const fields = requireArray(value, message, location).map((entry) => {
    const record = requireRecord(entry, message, location);
    requireExactKeys(record, ["field", "editor"], location);
    return Object.freeze({
      field: requireFieldKey(record.field, message, location),
      editor: parseInlineEditor(record.editor, location),
    });
  });
  if (
    fields.length === 0 ||
    new Set(fields.map((field) => field.field.toLowerCase())).size !== fields.length
  )
    fail(message, location);
  return Object.freeze(fields);
};

/** One projected filterable field: its identity, label, canonical type, filter kind and control facts. */
export const parseFilterField = (
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
    [
      "search",
      "columnFilters",
      "savedViews",
      "bulkActions",
      "inlineEdit",
      "rowEdit",
      "rowActions",
      "masterDetail",
      "tree",
      "grouping",
      "conditionalFormatting",
      "pinning",
      "pivot",
      "spreadsheet",
      "export",
    ],
    location,
  );
  if (Object.keys(record).length === 0) fail("Projected table features name no feature", location);
  if (record.pinning !== undefined && record.pinning !== true)
    fail("A projected pinning feature is only ever on", location);
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
  let rowActions: RecordsTableFeatureProjection["rowActions"];
  if (record.rowActions !== undefined) {
    const value = requireRecord(record.rowActions, "Projected row actions are invalid", location);
    requireExactKeys(value, ["actions", "availability"], location);
    const actions = requireArray(value.actions, "Row actions must be a list", location).map(
      (item): RecordsTableActionContract => {
        const action = requireRecord(item, "A row action is invalid", location);
        requireExactKeys(action, ["eventId", "label", "icon", "placement", "capability"], location);
        if (
          !(recordsTableRowActionIcons as readonly unknown[]).includes(action.icon) ||
          !["inline", "menu"].includes(action.placement as string) ||
          (action.capability !== undefined &&
            !(recordsTableActionCapabilities as readonly unknown[]).includes(action.capability))
        )
          fail("A row action has invalid settings", location);
        return {
          eventId: requireNonEmptyString(action.eventId, "A row action needs its event", location),
          label: requireNonEmptyString(action.label, "A row action needs its label", location),
          icon: action.icon as RecordsTableActionContract["icon"],
          placement: action.placement as RecordsTableActionContract["placement"],
          ...(action.capability === undefined
            ? {}
            : {
                capability: action.capability as NonNullable<
                  RecordsTableActionContract["capability"]
                >,
              }),
        };
      },
    );
    const availability = namedActionAvailabilitySchema.safeParse(value.availability);
    if (
      !availability.success ||
      actions.length === 0 ||
      actions.length > 20 ||
      new Set(actions.map((action) => action.eventId)).size !== actions.length
    )
      fail("Projected row action availability is invalid", location);
    rowActions = { actions, availability: availability.data! };
  }
  let exportFeature: RecordsTableFeatureProjection["export"];
  if (record.export !== undefined) {
    const exported = requireRecord(record.export, "Projected export is invalid", location);
    requireExactKeys(exported, ["maxRows", "formats"], location);
    if (
      typeof exported.maxRows !== "number" ||
      !Number.isInteger(exported.maxRows) ||
      exported.maxRows < 1 ||
      exported.maxRows > RECORDS_TABLE_EXPORT_MAXIMUM_ROWS
    )
      fail("Projected export has an invalid row limit", location);
    const formats = requireArray(
      exported.formats,
      "Projected export formats are invalid",
      location,
    );
    if (
      formats.length === 0 ||
      formats.length > recordsTableExportFormats.length ||
      new Set(formats).size !== formats.length ||
      formats.some((format) => !recordsTableExportFormats.some((known) => known === format))
    )
      fail("Projected export formats are invalid", location);
    exportFeature = Object.freeze({
      maxRows: exported.maxRows as number,
      formats: Object.freeze(formats as (typeof recordsTableExportFormats)[number][]),
    });
  }
  let rowEdit: RecordsTableFeatureProjection["rowEdit"];
  if (record.rowEdit !== undefined) {
    const row = requireRecord(record.rowEdit, "Projected row editing is invalid", location);
    requireExactKeys(row, ["eventId", "fields", "trigger"], location);
    if (row.trigger !== "button") fail("Row editing requires its button trigger", location);
    rowEdit = Object.freeze({
      eventId: requireNonEmptyString(row.eventId, "Row editing needs its event", location),
      trigger: "button",
      fields: parseInlineEditFields(row.fields, location),
    });
  }
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
      fields: parseInlineEditFields(inline.fields, location),
    });
  }
  let masterDetail: RecordsTableFeatureProjection["masterDetail"];
  if (record.masterDetail !== undefined) {
    const related = requireRecord(
      record.masterDetail,
      "Projected related records are invalid",
      location,
    );
    requireExactKeys(related, ["pageSize"], location);
    masterDetail = Object.freeze({
      pageSize: requirePositiveInteger(
        related.pageSize,
        "Related records need their page size",
        location,
      ),
    });
  }
  let tree: RecordsTableFeatureProjection["tree"];
  if (record.tree !== undefined) {
    const beneath = requireRecord(record.tree, "Projected tree is invalid", location);
    requireExactKeys(beneath, ["pageSize"], location);
    tree = Object.freeze({
      pageSize: requirePositiveInteger(beneath.pageSize, "A tree needs its page size", location),
    });
  }
  let grouping: RecordsTableFeatureProjection["grouping"];
  if (record.grouping !== undefined) {
    const held = requireRecord(record.grouping, "Projected grouping is invalid", location);
    requireExactKeys(
      held,
      ["fieldId", "label", "unassignedLabel", "opensGrouped", "required"],
      location,
    );
    if (typeof held.opensGrouped !== "boolean")
      fail("A projected grouping says whether it opens grouped", location);
    if (held.required !== undefined && held.required !== true)
      fail("A projected grouping says whether it is required", location);
    grouping = Object.freeze({
      ...(held.required === true ? { required: true as const } : {}),
      opensGrouped: held.opensGrouped,
      fieldId: requireNonEmptyString(held.fieldId, "Grouping needs its field", location),
      label: requireNonEmptyString(held.label, "Grouping needs its field's name", location),
      unassignedLabel: requireNonEmptyString(
        held.unassignedLabel,
        "Grouping needs the name of the records with no value",
        location,
      ),
    });
  }
  let pivot: RecordsTableFeatureProjection["pivot"];
  if (record.pivot !== undefined) {
    const held = requireRecord(record.pivot, "Projected pivot is invalid", location);
    requireExactKeys(held, ["rowPageSize", "totals", "view"], location);
    if (typeof held.totals !== "boolean")
      fail("A projected pivot says whether it totals", location);
    let view: { cursor?: string } | undefined;
    if (held.view !== undefined) {
      const opened = requireRecord(held.view, "A projected pivot view is invalid", location);
      requireExactKeys(opened, ["cursor"], location);
      view =
        opened.cursor === undefined
          ? {}
          : {
              cursor: requireNonEmptyString(
                opened.cursor,
                "A pivot view position must be text",
                location,
              ),
            };
    }
    pivot = Object.freeze({
      rowPageSize: requirePositiveInteger(
        held.rowPageSize,
        "A pivot needs its rows at a time",
        location,
      ),
      totals: held.totals as boolean,
      ...(view === undefined ? {} : { view: Object.freeze(view) }),
    });
  }
  let spreadsheet: RecordsTableFeatureProjection["spreadsheet"];
  if (record.spreadsheet !== undefined) {
    const controls = requireRecord(
      record.spreadsheet,
      "Projected spreadsheet controls are invalid",
      location,
    );
    requireExactKeys(
      controls,
      ["rangeSelect", "find", "paste", "fill", "undo", "statusBar"],
      location,
    );
    if (
      typeof controls.rangeSelect !== "boolean" ||
      typeof controls.find !== "boolean" ||
      (!controls.rangeSelect && !controls.find)
    )
      fail("Projected spreadsheet controls need an enabled control", location);
    for (const key of ["paste", "fill", "undo"] as const)
      if (controls[key] !== undefined && controls[key] !== true)
        fail(`The projected spreadsheet ${key} control is invalid`, location);
    if (
      (controls.undo === true && controls.paste !== true && controls.fill !== true) ||
      ((controls.paste === true || controls.fill === true) && controls.rangeSelect !== true)
    )
      fail("Projected paste, fill and undo need a range and an edit", location);
    let statusBar: NonNullable<RecordsTableFeatureProjection["spreadsheet"]>["statusBar"];
    if (controls.statusBar !== undefined) {
      const bar = requireRecord(
        controls.statusBar,
        "The projected status bar is invalid",
        location,
      );
      requireExactKeys(bar, ["fields", "operations"], location);
      const fields = requireArray(bar.fields, "The status bar fields are invalid", location).map(
        (field) => requireFieldKey(field, "A status bar field needs a stable key", location),
      );
      const operations = requireArray(
        bar.operations,
        "The status bar totals are invalid",
        location,
      ).map(
        (operation) =>
          recordsTableStatusBarOperations.find((known) => known === operation) ??
          fail(`Unknown status bar total '${String(operation)}'`, location),
      ) as RecordsTableStatusBarOperation[];
      if (
        controls.rangeSelect !== true ||
        fields.length === 0 ||
        operations.length === 0 ||
        fields.length > RECORDS_TABLE_STATUS_BAR_MAXIMUM_FIELDS ||
        new Set(fields).size !== fields.length ||
        new Set(operations).size !== operations.length
      )
        fail("The projected status bar needs a range and distinct fields and totals", location);
      statusBar = Object.freeze({
        fields: Object.freeze(fields),
        operations: Object.freeze(operations),
      });
    }
    spreadsheet = Object.freeze({
      rangeSelect: controls.rangeSelect as boolean,
      find: controls.find as boolean,
      ...(controls.paste === true ? { paste: true as const } : {}),
      ...(controls.fill === true ? { fill: true as const } : {}),
      ...(controls.undo === true ? { undo: true as const } : {}),
      ...(statusBar === undefined ? {} : { statusBar }),
    });
  }
  return Object.freeze({
    ...(pivot === undefined ? {} : { pivot }),
    ...(spreadsheet === undefined ? {} : { spreadsheet }),
    ...(record.pinning === true ? { pinning: true as const } : {}),
    ...(record.search === true ? { search: true as const } : {}),
    ...(columnFilters === undefined ? {} : { columnFilters }),
    ...(record.savedViews === true ? { savedViews: true as const } : {}),
    ...(bulkActions === undefined ? {} : { bulkActions: Object.freeze(bulkActions) }),
    ...(exportFeature === undefined ? {} : { export: exportFeature }),
    ...(inlineEdit === undefined ? {} : { inlineEdit }),
    ...(rowEdit === undefined ? {} : { rowEdit }),
    ...(rowActions === undefined ? {} : { rowActions }),
    ...(masterDetail === undefined ? {} : { masterDetail }),
    ...(tree === undefined ? {} : { tree }),
    ...(grouping === undefined ? {} : { grouping }),
    ...(record.conditionalFormatting === undefined
      ? {}
      : {
          conditionalFormatting: parseConditionalFormatting(record.conditionalFormatting, location),
        }),
  });
};

/** One group of a grouped table: its key, its label and how many records it holds right now. */
export type TableGroup = Readonly<{
  key: string;
  label: string;
  count: number;
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
      requireExactKeys(group, ["key", "label", "count", "unassigned"], location);
      if (group.unassigned !== undefined && group.unassigned !== true)
        fail("A projected group is only ever unassigned", location);
      if (typeof group.count !== "number" || !Number.isInteger(group.count) || group.count < 0)
        fail("A projected group count must be a whole number", location);
      return Object.freeze({
        key: requireNonEmptyString(group.key, "A projected group needs its key", location),
        label: requireNonEmptyString(group.label, "A projected group needs its label", location),
        count: group.count as number,
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
