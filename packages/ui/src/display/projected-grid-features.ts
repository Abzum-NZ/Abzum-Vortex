import {
  type RecordsTableActionContract,
  type RecordsTableFeatureProjection,
  type RecordsTableFilterField,
  type RecordsTableFilterValue,
  readRecordsTableFieldFilter,
  recordsTableActionCapabilities,
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
  requirePositiveInteger,
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

/** One projected bulk command: its flow binding's event identity, label and optional capability. */
const parseTableAction = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): RecordsTableActionContract => {
  const action = requireRecord(value, "A projected bulk command must be an object", location);
  requireExactKeys(action, ["eventId", "label", "capability"], location);
  const eventId = requireNonEmptyString(action.eventId, "A bulk command needs its event", location);
  const label = requireNonEmptyString(action.label, "A bulk command needs its label", location);
  if (
    action.capability !== undefined &&
    !(recordsTableActionCapabilities as readonly unknown[]).includes(action.capability)
  )
    fail("A bulk command names an unknown capability", location);
  return Object.freeze({
    eventId,
    label,
    ...(action.capability === undefined
      ? {}
      : { capability: action.capability as RecordsTableActionContract["capability"] & string }),
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
    [
      "search",
      "columnFilters",
      "savedViews",
      "bulkActions",
      "inlineEdit",
      "masterDetail",
      "conditionalFormatting",
      "pinning",
      "spreadsheet",
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
      : requireArray(record.bulkActions, "Projected bulk commands are invalid", location).map(
          (action) => parseTableAction(action, location),
        );
  if (bulkActions !== undefined && bulkActions.length === 0)
    fail("Projected bulk commands are empty", location);
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
  let spreadsheet: RecordsTableFeatureProjection["spreadsheet"];
  if (record.spreadsheet !== undefined) {
    const controls = requireRecord(
      record.spreadsheet,
      "Projected spreadsheet controls are invalid",
      location,
    );
    requireExactKeys(controls, ["rangeSelect", "find"], location);
    if (
      typeof controls.rangeSelect !== "boolean" ||
      typeof controls.find !== "boolean" ||
      (!controls.rangeSelect && !controls.find)
    )
      fail("Projected spreadsheet controls need an enabled control", location);
    spreadsheet = Object.freeze({
      rangeSelect: controls.rangeSelect as boolean,
      find: controls.find as boolean,
    });
  }
  return Object.freeze({
    ...(spreadsheet === undefined ? {} : { spreadsheet }),
    ...(record.pinning === true ? { pinning: true as const } : {}),
    ...(record.search === true ? { search: true as const } : {}),
    ...(columnFilters === undefined ? {} : { columnFilters }),
    ...(record.savedViews === true ? { savedViews: true as const } : {}),
    ...(bulkActions === undefined ? {} : { bulkActions: Object.freeze(bulkActions) }),
    ...(inlineEdit === undefined ? {} : { inlineEdit }),
    ...(masterDetail === undefined ? {} : { masterDetail }),
    ...(record.conditionalFormatting === undefined
      ? {}
      : {
          conditionalFormatting: parseConditionalFormatting(record.conditionalFormatting, location),
        }),
  });
};
