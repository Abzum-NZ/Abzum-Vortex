import {
  builderKeySchema,
  richTextDocumentV2Schema,
  safeHttpsUrlSchema,
  timestampSchema,
  type BlockPropertyValueV2Contract,
  type ComponentSemanticEventKind,
} from "@vortex/contracts";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";

/**
 * Validated structured rich-text document from the shared closed rich-text contract.
 * Derived from the platform property-value contract so no second representation exists.
 */
export type DisplayRichTextDocument = Extract<
  BlockPropertyValueV2Contract,
  { kind: "rich_text" }
>["value"];

/** One ordered block inside a validated rich-text document. */
export type DisplayRichTextBlock = DisplayRichTextDocument["blocks"][number];

/** One inline rich-text run; derived from the validated paragraph block shape. */
export type DisplayRichTextInline = Extract<
  DisplayRichTextBlock,
  { kind: "paragraph" }
>["children"][number];

/**
 * Closed projected display value rendered inside a cell, field, group or summary.
 * Every variant carries only a permitted presentation value; none can execute or fetch.
 */
export type DisplayCellValue =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "number"; value: number; formatted?: string }>
  | Readonly<{ kind: "boolean"; value: boolean }>
  | Readonly<{ kind: "date"; iso: string }> // ISO calendar date or offset timestamp
  | Readonly<{ kind: "choice"; key: string; label: string }>
  | Readonly<{ kind: "link"; address: string; label: string }>
  | Readonly<{ kind: "rich_text"; document: DisplayRichTextDocument }>
  | Readonly<{ kind: "empty" }>;

/** One permission-projected row addressed by its stable record identity. */
export type DisplayRow = Readonly<{
  recordId: string;
  cells: Readonly<Record<string, DisplayCellValue>>;
}>;

/** One declared table column; only declared columns are ever rendered. */
export type DisplayColumn = Readonly<{ key: string; label: string }>;

/** One labelled record-detail field. */
export type DisplayField = Readonly<{ key: string; label: string; value: DisplayCellValue }>;

/** One labelled summary value. */
export type DisplaySummaryValue = Readonly<{
  key: string;
  label: string;
  value: DisplayCellValue;
}>;

/** One permission-projected group with stable group identity and its own rows. */
export type DisplayGroup = Readonly<{
  groupId: string;
  label: string;
  headingKey: string;
  secondaryKey?: string;
  rows: readonly DisplayRow[];
  selectedRecordIds?: readonly string[];
  summary?: readonly DisplaySummaryValue[];
}>;

/** Closed per-component projected payload rendering the display component family. */
export type ProjectedDisplayValues =
  | Readonly<{ kind: "text"; value: DisplayCellValue }>
  | Readonly<{ kind: "rich_text"; document: DisplayRichTextDocument }>
  | Readonly<{
      kind: "list";
      rows: readonly DisplayRow[];
      headingKey: string;
      secondaryKey?: string;
      selectedRecordIds?: readonly string[];
      page?: number;
      pageCount?: number;
    }>
  | Readonly<{
      kind: "table";
      columns: readonly DisplayColumn[];
      rows: readonly DisplayRow[];
      selectedRecordIds?: readonly string[];
      sort?: Readonly<{ columnKey: string; direction: "ascending" | "descending" }>;
      page?: number;
      pageCount?: number;
    }>
  | Readonly<{ kind: "record_detail"; recordId: string; fields: readonly DisplayField[] }>
  | Readonly<{ kind: "grouped_data"; groups: readonly DisplayGroup[] }>
  | Readonly<{ kind: "summary_values"; values: readonly DisplaySummaryValue[] }>;

export type ProjectedDisplayValueKind = ProjectedDisplayValues["kind"];

/** Fixed, data-free refusal reasons; a refused state never carries a value. */
export type DisplayRefusalReason = "not_permitted" | "access_ended" | "not_found";

/**
 * Explicit, data-safe state passed for one placement.
 * Only the `ready` state carries values; loading, empty and refused cannot leak data.
 */
export type ProjectedDisplayData =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "empty" }>
  | Readonly<{ status: "refused"; reason: DisplayRefusalReason }>
  | Readonly<{ status: "ready"; values: ProjectedDisplayValues }>;

/** Declared semantic event names this display family can emit. */
export type DisplaySemanticEventName = Extract<
  ComponentSemanticEventKind,
  "refresh" | "row_action" | "selection_changed" | "sort_changed" | "page_changed"
>;

/**
 * One declared semantic event. Row and item events always carry stable identity;
 * no event is ever emitted without a real user interaction. The bound flow, not the
 * component, decides what a row action does.
 */
export type DisplaySemanticEvent =
  | Readonly<{ event: "refresh" }>
  | Readonly<{ event: "row_action"; recordId: string }>
  | Readonly<{ event: "selection_changed"; recordId: string; selected: boolean }>
  | Readonly<{
      event: "sort_changed";
      columnKey: string;
      direction: "ascending" | "descending";
    }>
  | Readonly<{ event: "page_changed"; page: number }>;

export type DisplayEventHandler = (event: DisplaySemanticEvent) => void;

/** Callbacks accepted by one placement, keyed only by declared event name. */
export type DisplayEventHandlers = Readonly<
  Partial<Record<DisplaySemanticEventName, DisplayEventHandler>>
>;

/** Permission-projected data keyed by stable placement identity. */
export type ProjectedDataByPlacement = Readonly<Record<string, ProjectedDisplayData>>;

/** Semantic callbacks keyed by stable placement identity. */
export type DisplayEventsByPlacement = Readonly<Record<string, DisplayEventHandlers>>;

const DISPLAY_REFUSAL_REASONS: readonly DisplayRefusalReason[] = [
  "not_permitted",
  "access_ended",
  "not_found",
];

const DISPLAY_EVENT_NAMES: readonly DisplaySemanticEventName[] = [
  "refresh",
  "row_action",
  "selection_changed",
  "sort_changed",
  "page_changed",
];

const LOADING_STATE: ProjectedDisplayData = Object.freeze({ status: "loading" });
const EMPTY_STATE: ProjectedDisplayData = Object.freeze({ status: "empty" });
const EMPTY_CELL: DisplayCellValue = Object.freeze({ kind: "empty" });
const EMPTY_HANDLERS: DisplayEventHandlers = Object.freeze({});
const ISO_CALENDAR_DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

const fail = (
  message: string,
  location: DefinitionRenderErrorLocation,
  propertyPath?: readonly string[],
): never => {
  throw new DefinitionRenderError(
    "INVALID_COMPOSITION",
    message,
    propertyPath === undefined ? location : { ...location, propertyPath },
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireRecord = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): Record<string, unknown> => (isRecord(value) ? value : fail(message, location));

const requireExactKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: DefinitionRenderErrorLocation,
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`Unexpected projected display field '${key}'`, location);
  }
};

const requireString = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => (typeof value === "string" ? value : fail(message, location));

const requireNonEmptyString = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => {
  const text = requireString(value, message, location);
  return text.trim().length > 0 ? text : fail(message, location);
};

const requireArray = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): readonly unknown[] => (Array.isArray(value) ? value : fail(message, location));

const requireBuilderKey = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => {
  const parsed = builderKeySchema.safeParse(value);
  return parsed.success ? parsed.data : fail(message, location);
};

const requirePositiveInteger = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1
    ? value
    : fail(message, location);

const requireFiniteNumber = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): number => (typeof value === "number" && Number.isFinite(value) ? value : fail(message, location));

const parseRichTextDocument = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): DisplayRichTextDocument => {
  const parsed = richTextDocumentV2Schema.safeParse(value);
  return parsed.success
    ? (parsed.data as DisplayRichTextDocument)
    : fail("Projected rich text must satisfy the structured rich-text contract", location);
};

const parseCellValue = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): DisplayCellValue => {
  const record = requireRecord(value, "A projected display value must be a closed value", location);
  switch (record.kind) {
    case "text":
      requireExactKeys(record, ["kind", "text"], location);
      return Object.freeze({
        kind: "text",
        text: requireString(record.text, "A text display value requires text", location),
      });
    case "number": {
      requireExactKeys(record, ["kind", "value", "formatted"], location);
      const numeric = requireFiniteNumber(
        record.value,
        "A number display value requires a finite number",
        location,
      );
      return record.formatted === undefined
        ? Object.freeze({ kind: "number", value: numeric })
        : Object.freeze({
            kind: "number",
            value: numeric,
            formatted: requireString(
              record.formatted,
              "A formatted number display value requires text",
              location,
            ),
          });
    }
    case "boolean":
      requireExactKeys(record, ["kind", "value"], location);
      return typeof record.value === "boolean"
        ? Object.freeze({ kind: "boolean", value: record.value })
        : fail("A boolean display value requires a boolean", location);
    case "date": {
      requireExactKeys(record, ["kind", "iso"], location);
      const iso = requireNonEmptyString(
        record.iso,
        "A date display value requires an ISO date or timestamp",
        location,
      );
      const isDate = ISO_CALENDAR_DATE.test(iso) && !Number.isNaN(Date.parse(iso));
      return isDate || timestampSchema.safeParse(iso).success
        ? Object.freeze({ kind: "date", iso })
        : fail("A date display value must be an ISO date or offset timestamp", location);
    }
    case "choice":
      requireExactKeys(record, ["kind", "key", "label"], location);
      return Object.freeze({
        kind: "choice",
        key: requireBuilderKey(record.key, "A choice display value requires a key", location),
        label: requireNonEmptyString(
          record.label,
          "A choice display value requires a label",
          location,
        ),
      });
    case "link": {
      requireExactKeys(record, ["kind", "address", "label"], location);
      const address = safeHttpsUrlSchema.safeParse(record.address);
      return address.success
        ? Object.freeze({
            kind: "link",
            address: address.data,
            label: requireNonEmptyString(
              record.label,
              "A link display value requires a label",
              location,
            ),
          })
        : fail("A link display value requires a safe HTTPS address", location);
    }
    case "rich_text":
      requireExactKeys(record, ["kind", "document"], location);
      return Object.freeze({
        kind: "rich_text",
        document: parseRichTextDocument(record.document, location),
      });
    case "empty":
      requireExactKeys(record, ["kind"], location);
      return EMPTY_CELL;
    default:
      return fail(`Unknown projected display value kind '${String(record.kind)}'`, location);
  }
};

const parseRows = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): readonly DisplayRow[] => {
  const items = requireArray(value, "Projected rows must be an array", location);
  const seen = new Set<string>();
  return Object.freeze(
    items.map((item, index) => {
      const rowLocation = { ...location, propertyPath: [`rows[${index}]`] };
      const record = requireRecord(item, "A projected row must be an object", rowLocation);
      requireExactKeys(record, ["recordId", "cells"], rowLocation);
      const recordId = requireNonEmptyString(
        record.recordId,
        "A projected row requires a stable record identity",
        rowLocation,
      );
      if (seen.has(recordId))
        fail(`Duplicate projected row identity '${recordId}'`, rowLocation);
      seen.add(recordId);
      const cellsRecord = requireRecord(
        record.cells,
        "A projected row requires a cells object",
        rowLocation,
      );
      const cells: Record<string, DisplayCellValue> = {};
      for (const [key, cell] of Object.entries(cellsRecord)) {
        const cellKey = requireBuilderKey(key, `Invalid projected cell key '${key}'`, rowLocation);
        cells[cellKey] = parseCellValue(cell, { ...rowLocation, propertyPath: [cellKey] });
      }
      return Object.freeze({ recordId, cells: Object.freeze(cells) });
    }),
  );
};

const parseColumns = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): readonly DisplayColumn[] => {
  const items = requireArray(value, "Projected columns must be an array", location);
  const seen = new Set<string>();
  return Object.freeze(
    items.map((item, index) => {
      const columnLocation = { ...location, propertyPath: [`columns[${index}]`] };
      const record = requireRecord(item, "A projected column must be an object", columnLocation);
      requireExactKeys(record, ["key", "label"], columnLocation);
      const key = requireBuilderKey(
        record.key,
        "A projected column requires a stable key",
        columnLocation,
      );
      if (seen.has(key)) fail(`Duplicate projected column key '${key}'`, columnLocation);
      seen.add(key);
      return Object.freeze({
        key,
        label: requireNonEmptyString(
          record.label,
          "A projected column requires a label",
          columnLocation,
        ),
      });
    }),
  );
};

const parseSelection = (
  value: unknown,
  rows: readonly DisplayRow[],
  location: DefinitionRenderErrorLocation,
): readonly string[] | undefined => {
  if (value === undefined) return undefined;
  const items = requireArray(value, "Selected record identities must be an array", location);
  const known = new Set(rows.map((row) => row.recordId));
  const seen = new Set<string>();
  return Object.freeze(
    items.map((item) => {
      const recordId = requireNonEmptyString(
        item,
        "A selected record identity must be a non-empty string",
        location,
      );
      if (!known.has(recordId))
        fail(`Selected record identity '${recordId}' is not a projected row`, location);
      if (seen.has(recordId))
        fail(`Duplicate selected record identity '${recordId}'`, location);
      seen.add(recordId);
      return recordId;
    }),
  );
};

const parsePagination = (
  page: unknown,
  pageCount: unknown,
  location: DefinitionRenderErrorLocation,
): Readonly<{ page: number; pageCount: number }> | undefined => {
  if (page === undefined && pageCount === undefined) return undefined;
  if (page === undefined || pageCount === undefined)
    fail("Projected pagination requires both page and pageCount", location);
  const parsedPage = requirePositiveInteger(
    page,
    "Projected page must be a positive integer",
    location,
  );
  const parsedCount = requirePositiveInteger(
    pageCount,
    "Projected pageCount must be a positive integer",
    location,
  );
  if (parsedPage > parsedCount)
    fail("Projected page cannot exceed the projected pageCount", location);
  return Object.freeze({ page: parsedPage, pageCount: parsedCount });
};

const parseSummaryValues = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): readonly DisplaySummaryValue[] => {
  const items = requireArray(value, "Projected summary values must be an array", location);
  const seen = new Set<string>();
  return Object.freeze(
    items.map((item, index) => {
      const summaryLocation = { ...location, propertyPath: [`values[${index}]`] };
      const record = requireRecord(item, "A summary value must be an object", summaryLocation);
      requireExactKeys(record, ["key", "label", "value"], summaryLocation);
      const key = requireBuilderKey(
        record.key,
        "A summary value requires a stable key",
        summaryLocation,
      );
      if (seen.has(key)) fail(`Duplicate summary value key '${key}'`, summaryLocation);
      seen.add(key);
      return Object.freeze({
        key,
        label: requireNonEmptyString(
          record.label,
          "A summary value requires a label",
          summaryLocation,
        ),
        value: parseCellValue(record.value, summaryLocation),
      });
    }),
  );
};

const parseFields = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): readonly DisplayField[] => {
  const items = requireArray(value, "Projected detail fields must be an array", location);
  const seen = new Set<string>();
  return Object.freeze(
    items.map((item, index) => {
      const fieldLocation = { ...location, propertyPath: [`fields[${index}]`] };
      const record = requireRecord(item, "A detail field must be an object", fieldLocation);
      requireExactKeys(record, ["key", "label", "value"], fieldLocation);
      const key = requireBuilderKey(
        record.key,
        "A detail field requires a stable key",
        fieldLocation,
      );
      if (seen.has(key)) fail(`Duplicate detail field key '${key}'`, fieldLocation);
      seen.add(key);
      return Object.freeze({
        key,
        label: requireNonEmptyString(
          record.label,
          "A detail field requires a label",
          fieldLocation,
        ),
        value: parseCellValue(record.value, fieldLocation),
      });
    }),
  );
};

const parseGroups = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): readonly DisplayGroup[] => {
  const items = requireArray(value, "Projected groups must be an array", location);
  const seen = new Set<string>();
  return Object.freeze(
    items.map((item, index) => {
      const groupLocation = { ...location, propertyPath: [`groups[${index}]`] };
      const record = requireRecord(item, "A projected group must be an object", groupLocation);
      requireExactKeys(
        record,
        ["groupId", "label", "headingKey", "secondaryKey", "rows", "selectedRecordIds", "summary"],
        groupLocation,
      );
      const groupId = requireNonEmptyString(
        record.groupId,
        "A projected group requires a stable identity",
        groupLocation,
      );
      if (seen.has(groupId)) fail(`Duplicate projected group identity '${groupId}'`, groupLocation);
      seen.add(groupId);
      const rows = parseRows(record.rows, groupLocation);
      const selection = parseSelection(record.selectedRecordIds, rows, groupLocation);
      return Object.freeze({
        groupId,
        label: requireNonEmptyString(record.label, "A projected group requires a label", groupLocation),
        headingKey: requireBuilderKey(
          record.headingKey,
          "A projected group requires a heading key",
          groupLocation,
        ),
        ...(record.secondaryKey === undefined
          ? {}
          : {
              secondaryKey: requireBuilderKey(
                record.secondaryKey,
                "A projected group secondary key is invalid",
                groupLocation,
              ),
            }),
        rows,
        ...(selection === undefined ? {} : { selectedRecordIds: selection }),
        ...(record.summary === undefined
          ? {}
          : { summary: parseSummaryValues(record.summary, groupLocation) }),
      });
    }),
  );
};

const parseProjectedValues = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): ProjectedDisplayValues => {
  const record = requireRecord(value, "Projected display values must be an object", location);
  switch (record.kind) {
    case "text":
      requireExactKeys(record, ["kind", "value"], location);
      return Object.freeze({ kind: "text", value: parseCellValue(record.value, location) });
    case "rich_text":
      requireExactKeys(record, ["kind", "document"], location);
      return Object.freeze({
        kind: "rich_text",
        document: parseRichTextDocument(record.document, location),
      });
    case "list": {
      requireExactKeys(
        record,
        ["kind", "rows", "headingKey", "secondaryKey", "selectedRecordIds", "page", "pageCount"],
        location,
      );
      const rows = parseRows(record.rows, location);
      const selection = parseSelection(record.selectedRecordIds, rows, location);
      const pagination = parsePagination(record.page, record.pageCount, location);
      return Object.freeze({
        kind: "list",
        rows,
        headingKey: requireBuilderKey(
          record.headingKey,
          "A projected list requires a heading key",
          location,
        ),
        ...(record.secondaryKey === undefined
          ? {}
          : {
              secondaryKey: requireBuilderKey(
                record.secondaryKey,
                "A projected list secondary key is invalid",
                location,
              ),
            }),
        ...(selection === undefined ? {} : { selectedRecordIds: selection }),
        ...(pagination === undefined ? {} : pagination),
      });
    }
    case "table": {
      requireExactKeys(
        record,
        ["kind", "columns", "rows", "selectedRecordIds", "sort", "page", "pageCount"],
        location,
      );
      const columns = parseColumns(record.columns, location);
      const rows = parseRows(record.rows, location);
      const selection = parseSelection(record.selectedRecordIds, rows, location);
      const pagination = parsePagination(record.page, record.pageCount, location);
      let sort: Readonly<{ columnKey: string; direction: "ascending" | "descending" }> | undefined;
      if (record.sort !== undefined) {
        requireExactKeys(requireRecord(record.sort, "Projected sort is invalid", location), [
          "columnKey",
          "direction",
        ], location);
        const sortRecord = record.sort as Record<string, unknown>;
        const columnKey = requireBuilderKey(
          sortRecord.columnKey,
          "A projected sort requires a column key",
          location,
        );
        if (!columns.some((column) => column.key === columnKey))
          fail(`Projected sort column '${columnKey}' is not a declared column`, location);
        if (sortRecord.direction !== "ascending" && sortRecord.direction !== "descending")
          fail("A projected sort direction must be ascending or descending", location);
        sort = Object.freeze({ columnKey, direction: sortRecord.direction });
      }
      return Object.freeze({
        kind: "table",
        columns,
        rows,
        ...(selection === undefined ? {} : { selectedRecordIds: selection }),
        ...(sort === undefined ? {} : { sort }),
        ...(pagination === undefined ? {} : pagination),
      });
    }
    case "record_detail":
      requireExactKeys(record, ["kind", "recordId", "fields"], location);
      return Object.freeze({
        kind: "record_detail",
        recordId: requireNonEmptyString(
          record.recordId,
          "A projected record detail requires a stable record identity",
          location,
        ),
        fields: parseFields(record.fields, location),
      });
    case "grouped_data":
      requireExactKeys(record, ["kind", "groups"], location);
      return Object.freeze({ kind: "grouped_data", groups: parseGroups(record.groups, location) });
    case "summary_values":
      requireExactKeys(record, ["kind", "values"], location);
      return Object.freeze({
        kind: "summary_values",
        values: parseSummaryValues(record.values, location),
      });
    default:
      return fail(`Unknown projected display values kind '${String(record.kind)}'`, location);
  }
};

/**
 * Validates unknown projected data for one placement and returns its frozen fail-closed shape.
 * Throws a located definition error for any unknown, malformed or over-sharing input.
 */
export const parseProjectedDisplayData = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): ProjectedDisplayData => {
  const record = requireRecord(value, "Projected display data must be an object", location);
  switch (record.status) {
    case "loading":
      requireExactKeys(record, ["status"], location);
      return LOADING_STATE;
    case "empty":
      requireExactKeys(record, ["status"], location);
      return EMPTY_STATE;
    case "refused": {
      requireExactKeys(record, ["status", "reason"], location);
      const reason = record.reason;
      if (
        typeof reason !== "string" ||
        !DISPLAY_REFUSAL_REASONS.includes(reason as DisplayRefusalReason)
      )
        return fail("A refused display state must use a fixed refusal reason", location);
      return Object.freeze({ status: "refused", reason: reason as DisplayRefusalReason });
    }
    case "ready":
      requireExactKeys(record, ["status", "values"], location);
      return Object.freeze({
        status: "ready",
        values: parseProjectedValues(record.values, location),
      });
    default:
      return fail(
        `Unknown projected display status '${String(record.status)}'`,
        location,
      );
  }
};

/** Validates unknown semantic callbacks for one placement keyed by declared event name. */
export const parseDisplayEventHandlers = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): DisplayEventHandlers => {
  if (value === undefined) return EMPTY_HANDLERS;
  const record = requireRecord(value, "Display semantic callbacks must be an object", location);
  const handlers: Partial<Record<DisplaySemanticEventName, DisplayEventHandler>> = {};
  for (const [name, handler] of Object.entries(record)) {
    if (!DISPLAY_EVENT_NAMES.includes(name as DisplaySemanticEventName))
      fail(`Unknown display semantic event '${name}'`, location);
    if (typeof handler !== "function")
      fail(`Display semantic event '${name}' must be a callback`, location);
    handlers[name as DisplaySemanticEventName] = handler as DisplayEventHandler;
  }
  return Object.freeze(handlers);
};

const parseKeyedRecords = <Value>(
  value: unknown,
  location: DefinitionRenderErrorLocation,
  parse: (entry: unknown, entryLocation: DefinitionRenderErrorLocation) => Value,
  message: string,
): Readonly<Record<string, Value>> => {
  if (value === undefined) return Object.freeze({});
  const record = requireRecord(value, message, location);
  // Own data properties only: a supplied "__proto__" key stays an ordinary (unknown) key.
  return Object.freeze(
    Object.fromEntries(
      Object.entries(record).map(([placementId, entry]) => {
        if (placementId.trim().length === 0)
          fail("A display surface key must be a non-empty placement identity", location);
        return [placementId, parse(entry, { ...location, placementId })] as const;
      }),
    ),
  );
};

/** Validates unknown projection data keyed by stable placement identity. */
export const parseProjectedDataByPlacement = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): ProjectedDataByPlacement =>
  parseKeyedRecords(
    value,
    location,
    (entry, entryLocation) => parseProjectedDisplayData(entry, entryLocation),
    "Projected display data must be keyed by placement identity",
  );

/** Validates unknown semantic callbacks keyed by stable placement identity. */
export const parseDisplayEventsByPlacement = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): DisplayEventsByPlacement =>
  parseKeyedRecords(
    value,
    location,
    (entry, entryLocation) => parseDisplayEventHandlers(entry, entryLocation),
    "Display semantic callbacks must be keyed by placement identity",
  );

/**
 * Rejects projection or callback entries that do not name a placement in the resolved tree.
 * Absent entries are allowed; a supplied entry must resolve to an exact stable identity.
 */
export const assertProjectionKeysArePlacements = (
  placementIds: ReadonlySet<string>,
  projectedData: unknown,
  displayEvents: unknown,
  location: DefinitionRenderErrorLocation = {},
): void => {
  const dataKeys =
    projectedData === undefined
      ? []
      : Object.keys(
          requireRecord(
            projectedData,
            "Projected display data must be keyed by placement identity",
            location,
          ),
        );
  const eventKeys =
    displayEvents === undefined
      ? []
      : Object.keys(
          requireRecord(
            displayEvents,
            "Display semantic callbacks must be keyed by placement identity",
            location,
          ),
        );
  for (const placementId of dataKeys) {
    if (!placementIds.has(placementId))
      fail(`Projected data names unknown placement '${placementId}'`, {
        ...location,
        placementId,
      });
  }
  for (const placementId of eventKeys) {
    if (!placementIds.has(placementId))
      fail(`Display events name unknown placement '${placementId}'`, {
        ...location,
        placementId,
      });
  }
};
