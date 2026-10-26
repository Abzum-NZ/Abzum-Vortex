export { parseCalendarPayload } from "./calendar-payload";
export {
  DISPLAY_EVENT_NAMES,
  type DisplayBatchEditAnswer,
  type DisplayEventHandler,
  type DisplayEventHandlers,
  type DisplayInlineEditResult,
  type DisplaySemanticEvent,
  type DisplaySemanticEventName,
} from "./display-events";
import {
  DISPLAY_EVENT_NAMES,
  type DisplayEventHandler,
  type DisplayEventHandlers,
  type DisplaySemanticEventName,
} from "./display-events";
import {
  jsonValueSchema,
  recordsTableTotalsSchema,
  type RecordsTableTotal,
  type JsonValue,
  fieldIdSchema,
  richTextPayloadSchema,
  textPayloadSchema,
  type RichTextPayload,
  type TextPayload,
  displaySummaryMetricsSchema,
  summaryPayloadSchema,
  type DisplaySummaryMetric,
  type SummaryPayload,
  displayDataStateSchema,
  displayDetailCellSchema,
  displayScalarCellSchema,
  type DisplayDataState,
  type DisplayDetailCell,
  type DisplayScalarCell,
  type DisplayTableField,
  type BlockPropertyValueContract,
  type ConditionalFormatStyle,
  type PipelineStageTone,
  type RecordsTableFeatureProjection,
  type RecordsTableRowFormat,
  type RecordsTableFilterField,
  type RecordsTableFilterValue,
  type RecordsTableSortKey,
  type RecordsTableSortState,
  RECORDS_TABLE_MAXIMUM_SORT_KEYS,
  gridLayoutStateSchema,
  recordsTableFeatureProjectionSchema,
  type GridLayoutState,
} from "@vortex/platform/schema";
import type { DefinitionRenderErrorLocation } from "../definition-error";
import { parseRowFormat } from "./projected-format";
import {
  parseTableGroups,
  parseTableNarrowing,
  parseTableSelectionParts,
  parseSelectedRecordIds,
  type TableGroups,
  type TableSelectionParts,
} from "./projected-grid-features";
import {
  fail,
  requireRecord,
  requireExactKeys,
  requireNonEmptyString,
  requireArray,
  requireFieldKey,
  requirePositiveInteger,
  requireBuilderKey,
} from "./payload-parse";

export {
  isInternalAddress,
  type DisplayDataState,
  type DisplayRefusalReason,
} from "@vortex/platform/schema";
export type { DisplaySummaryMetric, RichTextPayload, SummaryPayload, TextPayload };

/**
 * Validated structured rich-text document from the shared closed rich-text contract.
 * Derived from the platform property-value contract so no second representation exists.
 */
export type DisplayRichTextDocument = Extract<
  BlockPropertyValueContract,
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
 * A table field's rows are accepted only as a record-detail field value.
 */
export type DisplayCellValue = DisplayDetailCell;

/**
 * A table field's rows on a record detail: its declared columns with readable headings, the first
 * page of rows with each row's scalar cells keyed by exactly those columns, and the field's total
 * row count, never fewer than the rows shown.
 */
export type DisplayTableFieldValue = DisplayTableField;

/** One display value that is not itself a table. */
export type DisplayScalarCellValue = DisplayScalarCell;

/** The record action kinds a row may report as available to the viewer. */
const displayRowActionKinds = ["update", "delete", "restore"] as const;
type DisplayRowActionKind = (typeof displayRowActionKinds)[number];

/**
 * The per-row capabilities the Query engine decided for the viewer: the fields it may change on
 * this row and the record actions it may take. They only hide controls; the server re-checks
 * every change and action.
 */
type DisplayRowCapabilities = Readonly<{
  changeableFieldIds: readonly string[];
  actions: readonly DisplayRowActionKind[];
}>;

/**
 * One permission-projected row addressed by its stable record identity. A Records table row also
 * carries the record revision an inline edit sends and its per-row capabilities; either is absent
 * when the payload does not carry it, and is never inferred.
 */
export type DisplayRow = Readonly<{
  recordId: string;
  revision?: number;
  capabilities?: DisplayRowCapabilities;
  /**
   * The stored value of each field the viewer may edit on this row (null when empty), as the
   * field's own contract spells it. An editor starts from this, never from a displayed cell.
   */
  edit?: Readonly<Record<string, JsonValue>>;
  cells: Readonly<Record<string, DisplayCellValue>>;
  /** The style keys and measures the table's formatting gives the row, decided on the server. */
  format?: RecordsTableRowFormat;
  /**
   * A tree row the viewer may read a matching child of, decided on the server; "unknown" when the
   * server stopped before deciding, so the child level is read when the row is opened.
   */
  hasChildren?: true | "unknown";
  /** The exact text of each readable number and money cell, for the range copy (see the server). */
  exact?: Readonly<Record<string, string>>;
}>;

/** One declared table column; only declared columns are ever rendered. */
export type DisplayColumn = Readonly<{ key: string; label: string }>;

/** One labelled record-detail field. */
export type DisplayField = Readonly<{ key: string; label: string; value: DisplayCellValue }>;

/** The ready rows a launcher or link-tile block renders. */
export type LauncherRowsPayload = Readonly<{
  kind: "launcher_rows";
  rows: readonly DisplayRow[];
  headingKey: string;
  secondaryKey?: string;
}>;

/** The viewer's search and filters one table page was read with. */
export type TableNarrowing = Readonly<{
  search: string | null;
  filters: readonly RecordsTableFilterValue[];
  /** The titles of the records the link filters name (record identity to title). */
  recordTitles?: Readonly<Record<string, string>>;
}>;

/** The ready values a table block renders. */
export type TablePayload = Readonly<{
  kind: "table";
  /** Declared sort fields readable on every record for this viewer. */
  sortableFields: readonly string[];
  columns: readonly DisplayColumn[];
  /**
   * The declared columns the page was read without, in declared order: headings only. Showing one
   * reads the page again with it; hiding a shown column narrows the next read.
   */
  hiddenColumns: readonly DisplayColumn[];
  /** The person's layout of the grid: column order, shown columns, widths and density. */
  layout: GridLayoutState;
  rows: readonly DisplayRow[];
  /**
   * Present when the table is grouped: the groups and their counts. The rows are then the open
   * group's members only, so a closed table carries none.
   */
  groups?: TableGroups;
  totals?: readonly RecordsTableTotal[];
  /**
   * The grid features the server projected for this viewer and read; absent when every feature is
   * off. The table draws a feature only from this projection, never from its settings alone.
   */
  features?: RecordsTableFeatureProjection;
  selectedRecordIds?: readonly string[];
  /**
   * The order the page was read in, when it is the viewer's sort or the authored default sort;
   * absent when the bound query's own order applies. A key may name a sorted field that is not a
   * visible column.
   */
  sort?: RecordsTableSortState;
  /**
   * The order the page address asks for while the page read in it is still on its way; the sort
   * controls show it and a next sort gesture builds on it. Absent once the rows read in that order
   * are shown, so `sort` alone names the order of the rows on screen.
   */
  requestedSort?: RecordsTableSortState;
  /**
   * The search and filters the page was read with; the table shows them in its controls and tells
   * a page that matched nothing apart from a table with no records.
   */
  narrowing?: TableNarrowing;
  page?: number;
  pageCount?: number;
  hasNextPage?: boolean;
  nextContinuationToken?: string;
  /** The read's scan budget ran out before the page filled: more records may match on the next page. */
  scanLimited?: boolean;
  hasPreviousPage?: boolean;
  previousContinuationToken?: string;
}> &
  TableSelectionParts;

export type CalendarView = "month" | "week" | "agenda";

/** One permitted query row placed on a calendar day and shown with its declared title field. */
type CalendarItemPayload = Readonly<{
  recordId: string;
  start: string;
  end: string | null;
  title: string;
}>;

/** The server-computed bounded window and arranged calendar items for one placement. */
export type CalendarPayload = Readonly<{
  kind: "calendar";
  view: CalendarView;
  date: string;
  windowStart: string;
  windowEnd: string;
  timeZone: string;
  endExclusive: boolean;
  truncated: boolean;
  items: readonly CalendarItemPayload[];
}>;

/** The ready values a record-detail block renders. */
export type RecordDetailPayload = Readonly<{
  kind: "record_detail";
  recordId: string;
  fields: readonly DisplayField[];
  heading?: DisplayCellValue;
}>;

/** One fetched page of cards in a protected board bucket. */
export type BoardPage = Readonly<{
  rows: readonly Readonly<{
    recordId: string;
    revision: number;
    capabilities: DisplayRowCapabilities;
    /** Only currently readable declared card fields are present, each with its safe label. */
    fields: readonly DisplayField[];
    /** The key of the Formatting rule that styles the whole card, decided by the server. */
    format?: Readonly<{ row: string }>;
  }>[];
  nextContinuationToken?: string;
}>;

/** Exact current protected totals plus a bounded page, or null when this bucket was untouched. */
export type BoardBucketPayload = Readonly<{
  state: "unread" | "reading" | "read";
  rowCount: number | null;
  aggregates: readonly DisplaySummaryMetric[];
  page: BoardPage | null;
}>;

/**
 * One installed choice column in its pipeline's stage order: its colour role from the theme, the
 * stages a card in it may move to, the named action that owns it, if one does, and whether a new
 * record may start in it.
 */
export type BoardColumnPayload = BoardBucketPayload &
  Readonly<{
    value: string;
    label: string;
    tone: PipelineStageTone;
    moves: readonly string[];
    gatedBy?: string;
    /** A new record may start in this stage, so quick add offers it. */
    addable: boolean;
  }>;

/** The ready values a Data grid in Board mode renders. */
export type BoardPayload = Readonly<{
  kind: "board";
  plan: Readonly<{
    moduleRootId: string;
    moduleReleaseVersion: string;
    queryId: string;
  }>;
  choiceFieldId: string;
  /** The key a card move names the choice field by when it asks for the record to be saved. */
  choiceFieldKey: string;
  choiceFieldRequired: boolean;
  /** The cards a column should not exceed; a column holding more warns. */
  wipLimit?: number;
  /** Each stage column offers adding a card there. */
  quickAdd: boolean;
  /**
   * The fields people may filter the cards by and the filters this read applied; absent when the
   * board offers no filters. The board shows them and reports changes; the server narrows.
   */
  filters?: Readonly<{
    fields: readonly RecordsTableFilterField[];
    applied: readonly RecordsTableFilterValue[];
  }>;
  /** The styles cards name through `format`; absent when the board has no Formatting. */
  formatting?: Readonly<{ styles: Readonly<Record<string, ConditionalFormatStyle>> }>;
  cardTitleFieldId: string;
  /** The only field identities a card may carry; readable values and labels may be omitted. */
  cardFieldIds: readonly string[];
  columns: readonly BoardColumnPayload[];
  /** Cards with no stage yet, and the stages they may move to: the start stage and its moves. */
  unassigned: BoardBucketPayload & Readonly<{ moves: readonly string[] }>;
}>;

export type TextData = DisplayDataState<TextPayload>;
export type RichTextData = DisplayDataState<RichTextPayload>;
export type LauncherRowsData = DisplayDataState<LauncherRowsPayload>;
export type TableData = DisplayDataState<TablePayload>;
export type RecordDetailData = DisplayDataState<RecordDetailPayload>;
export type SummaryData = DisplayDataState<SummaryPayload>;
export type BoardData = DisplayDataState<BoardPayload>;

// The data-free states carry no values, so one frozen instance serves every block's state type.
const LOADING_STATE: DisplayDataState<never> = Object.freeze({ status: "loading" });
const EMPTY_STATE: DisplayDataState<never> = Object.freeze({ status: "empty" });
const ERROR_STATE: DisplayDataState<never> = Object.freeze({ status: "error" });

/** A web link opens in a new page; a mail or telephone link hands over to the viewer's own app. */
export const isWebLinkAddress = (value: string): boolean => /^https?:/i.test(value);

/** A Zod issue path as a property path: an index joins the property before it (`rows[3]`). */
const propertyPathOf = (path: readonly PropertyKey[]): string[] =>
  path.reduce<string[]>((parts, segment) => {
    const last = parts.at(-1);
    return typeof segment === "number" && last !== undefined
      ? [...parts.slice(0, -1), `${last}[${segment}]`]
      : [...parts, String(segment)];
  }, []);

/**
 * @internal Parses one part of a payload with the platform schema that also describes what the
 * server builds; a refusal names the part and the setting that does not fit.
 */
export const parseProjectedPart = <Output>(
  schema: {
    safeParse(value: unknown):
      | { success: true; data: Output }
      | {
          success: false;
          error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] };
        };
  },
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): Output => {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  return fail(
    `${message}: ${issue?.message ?? "invalid"}`,
    location,
    propertyPathOf(issue?.path ?? []),
  );
};

/**
 * @internal A block's ready values parser: its platform payload schema, refused with a located
 * error.
 */
export const projectedValuesParser =
  <Output>(schema: Parameters<typeof parseProjectedPart<Output>>[0], message: string) =>
  (value: unknown, location: DefinitionRenderErrorLocation = {}): Output =>
    parseProjectedPart(schema, value, message, location);

const parseCellValue = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): DisplayScalarCellValue =>
  parseProjectedPart(
    displayScalarCellSchema,
    value,
    "A projected display value is invalid",
    location,
  );

/** A record-detail field value: a scalar value, or a table field's rows. */
const parseDetailFieldValue = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): DisplayCellValue =>
  parseProjectedPart(
    displayDetailCellSchema,
    value,
    "A projected detail value is invalid",
    location,
  );

/** @internal Shared with the board payload parser. */
export const parseRowCapabilities = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): DisplayRowCapabilities => {
  const record = requireRecord(value, "Row capabilities must be an object", location);
  requireExactKeys(record, ["changeableFieldIds", "actions"], location);
  const changeable = requireArray(
    record.changeableFieldIds,
    "Row capabilities require a changeable field list",
    location,
  ).map((fieldId) =>
    requireFieldKey(fieldId, `Invalid changeable field '${String(fieldId)}'`, location),
  );
  if (new Set(changeable.map((fieldId) => fieldId.toLowerCase())).size !== changeable.length)
    fail("Each changeable field is reported once", location);
  const actions = requireArray(
    record.actions,
    "Row capabilities require an action list",
    location,
  ).map(
    (action) =>
      displayRowActionKinds.find((kind) => kind === action) ??
      fail(`Unknown row action '${String(action)}'`, location),
  );
  if (new Set(actions).size !== actions.length) fail("Each row action is reported once", location);
  return Object.freeze({
    changeableFieldIds: Object.freeze(changeable),
    actions: Object.freeze(actions),
  });
};

/** The stored values of a row's editable fields: JSON in the field's own contract, keyed by field. */
const parseEditValues = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): Readonly<Record<string, JsonValue>> => {
  const record = requireRecord(value, "A projected row's edit values must be an object", location);
  const values: Record<string, JsonValue> = {};
  for (const [key, held] of Object.entries(record)) {
    const field = requireFieldKey(key, `Invalid projected edit key '${key}'`, location);
    if (!jsonValueSchema.safeParse(held).success)
      fail(`A projected edit value for '${field}' is not JSON`, location);
    values[field] = held as JsonValue;
  }
  return Object.freeze(values);
};

/** The exact number and money texts of a row's cells, keyed by column. */
const parseExactValues = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): Readonly<Record<string, string>> => {
  const record = requireRecord(value, "A projected row's exact values must be an object", location);
  const values: Record<string, string> = {};
  for (const [key, held] of Object.entries(record)) {
    const field = requireFieldKey(key, `Invalid projected exact key '${key}'`, location);
    values[field] = requireNonEmptyString(held, "A projected exact value must be text", location);
  }
  return Object.freeze(values);
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
      requireExactKeys(
        record,
        ["recordId", "revision", "capabilities", "edit", "cells", "format", "hasChildren", "exact"],
        rowLocation,
      );
      if (
        record.hasChildren !== undefined &&
        record.hasChildren !== true &&
        record.hasChildren !== "unknown"
      )
        fail("A projected row can only say it has or may have children", rowLocation);
      const recordId = requireNonEmptyString(
        record.recordId,
        "A projected row requires a stable record identity",
        rowLocation,
      );
      if (seen.has(recordId)) fail(`Duplicate projected row identity '${recordId}'`, rowLocation);
      seen.add(recordId);
      const cellsRecord = requireRecord(
        record.cells,
        "A projected row requires a cells object",
        rowLocation,
      );
      const cells: Record<string, DisplayCellValue> = {};
      for (const [key, cell] of Object.entries(cellsRecord)) {
        const cellKey = requireFieldKey(key, `Invalid projected cell key '${key}'`, rowLocation);
        cells[cellKey] = parseCellValue(cell, { ...rowLocation, propertyPath: [cellKey] });
      }
      const revision =
        record.revision === undefined
          ? undefined
          : requirePositiveInteger(
              record.revision,
              "A projected row revision must be a positive integer",
              rowLocation,
            );
      if (revision !== undefined && !Number.isSafeInteger(revision))
        fail("A projected row revision must be a safe integer", rowLocation);
      const capabilities =
        record.capabilities === undefined
          ? undefined
          : parseRowCapabilities(record.capabilities, {
              ...rowLocation,
              propertyPath: [`rows[${index}]`, "capabilities"],
            });
      const edit =
        record.edit === undefined
          ? undefined
          : parseEditValues(record.edit, {
              ...rowLocation,
              propertyPath: [`rows[${index}]`, "edit"],
            });
      const format =
        record.format === undefined
          ? undefined
          : parseRowFormat(record.format, {
              ...rowLocation,
              propertyPath: [`rows[${index}]`, "format"],
            });
      const exact =
        record.exact === undefined
          ? undefined
          : parseExactValues(record.exact, {
              ...rowLocation,
              propertyPath: [`rows[${index}]`, "exact"],
            });
      return Object.freeze({
        recordId,
        ...(exact === undefined ? {} : { exact }),
        ...(revision === undefined ? {} : { revision }),
        ...(capabilities === undefined ? {} : { capabilities }),
        ...(edit === undefined ? {} : { edit }),
        cells: Object.freeze(cells),
        ...(format === undefined ? {} : { format }),
        ...(record.hasChildren === true || record.hasChildren === "unknown"
          ? { hasChildren: record.hasChildren }
          : {}),
      });
    }),
  );
};

const parseColumns = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
  property = "columns",
  seen = new Set<string>(),
): readonly DisplayColumn[] => {
  const items = requireArray(value, "Projected columns must be an array", location);
  return Object.freeze(
    items.map((item, index) => {
      const columnLocation = { ...location, propertyPath: [`${property}[${index}]`] };
      const record = requireRecord(item, "A projected column must be an object", columnLocation);
      requireExactKeys(record, ["key", "label"], columnLocation);
      const key = requireFieldKey(
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

/** @internal Shared with the pivot feature, whose cells are summary values. */
export const parseSummaryValue = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): DisplaySummaryMetric["value"] => parseCellValue(value, location);

/** @internal Shared with the board payload parser. */
export const parseSummaryMetrics = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): readonly DisplaySummaryMetric[] =>
  parseProjectedPart(
    displaySummaryMetricsSchema,
    value,
    "Projected summary values are invalid",
    location,
  );

/**
 * @internal Shared with the board payload parser. A board card's fields are scalar; only a record
 * detail passes the detail value parser that also accepts a table field's rows.
 */
export const parseFields = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
  parseValue: (
    value: unknown,
    location: DefinitionRenderErrorLocation,
  ) => DisplayCellValue = parseCellValue,
): readonly DisplayField[] => {
  const items = requireArray(value, "Projected detail fields must be an array", location);
  const seen = new Set<string>();
  return Object.freeze(
    items.map((item, index) => {
      const fieldLocation = { ...location, propertyPath: [`fields[${index}]`] };
      const record = requireRecord(item, "A detail field must be an object", fieldLocation);
      requireExactKeys(record, ["key", "label", "value"], fieldLocation);
      const key = requireFieldKey(
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
        value: parseValue(record.value, fieldLocation),
      });
    }),
  );
};

/** The ready values a plain-text block accepts. */
export const parseTextPayload = projectedValuesParser(
  textPayloadSchema,
  "Projected text values are invalid",
);

/** The ready values a structured rich-text block accepts. */
export const parseRichTextPayload = projectedValuesParser(
  richTextPayloadSchema,
  "Projected rich text values are invalid",
);

/** The ready rows a launcher or link-tile block accepts. */
export const parseLauncherRowsPayload = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): LauncherRowsPayload => {
  const record = requireRecord(value, "Projected display values must be an object", location);
  if (record.kind !== "launcher_rows")
    return fail(
      `Expected 'launcher_rows' projected values, got '${String(record.kind)}'`,
      location,
    );
  requireExactKeys(record, ["kind", "rows", "headingKey", "secondaryKey"], location);
  const rows = parseRows(record.rows, location);
  return Object.freeze({
    kind: "launcher_rows",
    rows,
    headingKey: requireBuilderKey(
      record.headingKey,
      "Projected launcher rows require a heading key",
      location,
    ),
    ...(record.secondaryKey === undefined
      ? {}
      : {
          secondaryKey: requireBuilderKey(
            record.secondaryKey,
            "The projected launcher secondary key is invalid",
            location,
          ),
        }),
  });
};

/** The order of a table's rows: one to twenty distinct fields, each ascending or descending. */
const parseTableSort = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): RecordsTableSortState => {
  const sortRecord = requireRecord(value, "Projected sort is invalid", location);
  requireExactKeys(sortRecord, ["keys", "explicit"], location);
  if (typeof sortRecord.explicit !== "boolean")
    fail("A projected sort must say whether the viewer chose it", location);
  const items = requireArray(sortRecord.keys, "Projected sort keys must be an array", location);
  if (items.length === 0 || items.length > RECORDS_TABLE_MAXIMUM_SORT_KEYS)
    fail("A projected sort holds between one and twenty keys", location);
  const keys = items.map((item): RecordsTableSortKey => {
    const key = requireRecord(item, "A projected sort key must be an object", location);
    requireExactKeys(key, ["fieldId", "direction"], location);
    const fieldId = requireFieldKey(key.fieldId, "A projected sort key requires a field", location);
    if (key.direction !== "ascending" && key.direction !== "descending")
      fail("A projected sort direction must be ascending or descending", location);
    return Object.freeze({ fieldId, direction: key.direction });
  });
  if (new Set(keys.map((key) => key.fieldId.toLowerCase())).size !== keys.length)
    fail("A projected sort names each field once", location);
  return Object.freeze({ keys: Object.freeze(keys), explicit: sortRecord.explicit });
};

/** The ready values a table block accepts. */
export const parseTablePayload = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): TablePayload => {
  const record = requireRecord(value, "Projected display values must be an object", location);
  if (record.kind !== "table")
    return fail(`Expected 'table' projected values, got '${String(record.kind)}'`, location);
  requireExactKeys(
    record,
    [
      "kind",
      "sortableFields",
      "columns",
      "hiddenColumns",
      "layout",
      "rows",
      "groups",
      "totals",
      "features",
      "selectedRecordIds",
      "sort",
      "requestedSort",
      "narrowing",
      "page",
      "pageCount",
      "hasNextPage",
      "nextContinuationToken",
      "scanLimited",
      "hasPreviousPage",
      "previousContinuationToken",
      "selectionToken",
      "selectionScope",
      "bulkRun",
      "exportRun",
      "actionAvailability",
    ],
    location,
  );
  // A column is either shown or hidden, never both.
  const seenColumns = new Set<string>();
  const sortableFields = requireArray(
    record.sortableFields,
    "Projected sortable fields must be an array",
    location,
  ).map((field) =>
    parseProjectedPart(fieldIdSchema, field, "A projected sortable field is invalid", location),
  );
  const columns = parseColumns(record.columns, location, "columns", seenColumns);
  const hiddenColumns = parseColumns(record.hiddenColumns, location, "hiddenColumns", seenColumns);
  const layout = gridLayoutStateSchema.safeParse(record.layout);
  if (!layout.success) fail("A projected table layout is invalid", location);
  // The layout arranges exactly the declared columns the page carries, shown or hidden.
  const layoutKeys = new Set(layout.data.layout.columns.map((column) => column.fieldId));
  const carriedKeys = new Set([...seenColumns].map((key) => key.toLowerCase()));
  if (layoutKeys.size !== carriedKeys.size || [...carriedKeys].some((key) => !layoutKeys.has(key)))
    fail("A projected table layout must arrange exactly the declared columns", location);
  const rows = parseRows(record.rows, location);
  const selection = parseSelectedRecordIds(record.selectedRecordIds, location);
  const page =
    record.page === undefined
      ? undefined
      : requirePositiveInteger(record.page, "Projected page must be a positive integer", location);
  const pageCount =
    record.pageCount === undefined
      ? undefined
      : requirePositiveInteger(
          record.pageCount,
          "Projected pageCount must be a positive integer",
          location,
        );
  if (pageCount !== undefined && (page === undefined || page > pageCount))
    fail("Projected pagination requires a page within pageCount", location);
  if (record.hasNextPage !== undefined && typeof record.hasNextPage !== "boolean")
    fail("Projected hasNextPage must be a boolean", location);
  const hasNextPage = record.hasNextPage as boolean | undefined;
  if (record.hasPreviousPage !== undefined && typeof record.hasPreviousPage !== "boolean")
    fail("Projected hasPreviousPage must be a boolean", location);
  const hasPreviousPage = record.hasPreviousPage as boolean | undefined;
  if (record.scanLimited !== undefined && typeof record.scanLimited !== "boolean")
    fail("Projected scanLimited must be a boolean", location);
  const scanLimited = record.scanLimited as boolean | undefined;
  let nextContinuationToken: string | undefined;
  if (record.nextContinuationToken !== undefined) {
    nextContinuationToken = requireNonEmptyString(
      record.nextContinuationToken,
      "A table continuation token must be a non-empty string",
      location,
    );
    if (nextContinuationToken.length > 65_536)
      fail("A table continuation token is too long", location);
  }
  if (scanLimited === true && !hasNextPage)
    fail("A scan-limited page requires a next page", location);
  if (
    (hasNextPage === true) !== (nextContinuationToken !== undefined) ||
    ((hasNextPage !== undefined || nextContinuationToken !== undefined) && page === undefined)
  )
    fail("Table continuation state is incomplete", location);
  let previousContinuationToken: string | undefined;
  if (record.previousContinuationToken !== undefined) {
    previousContinuationToken = requireNonEmptyString(
      record.previousContinuationToken,
      "A table previous token must be a non-empty string",
      location,
    );
    if (previousContinuationToken.length > 65_536)
      fail("A table previous token is too long", location);
  }
  if ((hasPreviousPage === true) !== (previousContinuationToken !== undefined))
    fail("Table previous state is incomplete", location);
  const sort = record.sort === undefined ? undefined : parseTableSort(record.sort, location);
  const requestedSort =
    record.requestedSort === undefined ? undefined : parseTableSort(record.requestedSort, location);
  const narrowing =
    record.narrowing === undefined ? undefined : parseTableNarrowing(record.narrowing, location);
  const features =
    record.features === undefined
      ? undefined
      : parseProjectedPart(
          recordsTableFeatureProjectionSchema,
          record.features,
          "Projected table features are invalid",
          location,
        );
  const groups =
    record.groups === undefined ? undefined : parseTableGroups(record.groups, location);
  const selectionParts = parseTableSelectionParts(record, location);
  return Object.freeze({
    kind: "table",
    sortableFields,
    columns,
    hiddenColumns,
    layout: layout.data,
    rows,
    ...(groups === undefined ? {} : { groups }),
    ...(record.totals === undefined
      ? {}
      : {
          totals: parseProjectedPart(
            recordsTableTotalsSchema,
            record.totals,
            "Projected grid totals are invalid",
            location,
          ),
        }),
    ...(features === undefined ? {} : { features }),
    ...selectionParts,
    ...(selection === undefined ? {} : { selectedRecordIds: selection }),
    ...(sort === undefined ? {} : { sort }),
    ...(requestedSort === undefined ? {} : { requestedSort }),
    ...(narrowing === undefined ? {} : { narrowing }),
    ...(page === undefined ? {} : { page }),
    ...(pageCount === undefined ? {} : { pageCount }),
    ...(hasNextPage === undefined ? {} : { hasNextPage }),
    ...(nextContinuationToken === undefined ? {} : { nextContinuationToken }),
    ...(scanLimited === undefined ? {} : { scanLimited }),
    ...(hasPreviousPage === undefined ? {} : { hasPreviousPage }),
    ...(previousContinuationToken === undefined ? {} : { previousContinuationToken }),
  });
};

/** The ready values a record-detail block accepts. */
export const parseRecordDetailPayload = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): RecordDetailPayload => {
  const record = requireRecord(value, "Projected display values must be an object", location);
  if (record.kind !== "record_detail")
    return fail(
      `Expected 'record_detail' projected values, got '${String(record.kind)}'`,
      location,
    );
  requireExactKeys(record, ["kind", "recordId", "fields", "heading"], location);
  return Object.freeze({
    kind: "record_detail",
    recordId: requireNonEmptyString(
      record.recordId,
      "A projected record detail requires a stable record identity",
      location,
    ),
    fields: parseFields(record.fields, location, parseDetailFieldValue),
    ...(record.heading === undefined ? {} : { heading: parseCellValue(record.heading, location) }),
  });
};

/** The ready values a summary-values block accepts. */
export const parseSummaryPayload = projectedValuesParser(
  summaryPayloadSchema,
  "Projected summary values are invalid",
);

/**
 * Validates one block's unknown projected state and returns its frozen fail-closed shape. Only the
 * `ready` state reaches that block's own payload parser, so every accepted shape stays the
 * registration's own concern. Throws a located definition error for any unknown, malformed or
 * over-sharing input.
 */
export const parseDisplayData = <Values>(
  value: unknown,
  parseValues: (value: unknown, location: DefinitionRenderErrorLocation) => Values,
  location: DefinitionRenderErrorLocation = {},
): DisplayDataState<Values> => {
  const state = parseProjectedPart(
    displayDataStateSchema,
    value,
    "Projected display data is invalid",
    location,
  );
  switch (state.status) {
    case "loading":
      return LOADING_STATE;
    case "empty":
      return EMPTY_STATE;
    case "error":
      return ERROR_STATE;
    case "ready":
      return Object.freeze({ status: "ready", values: parseValues(state.values, location) });
    default:
      return state;
  }
};

const EMPTY_HANDLERS: DisplayEventHandlers = Object.freeze({});

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
