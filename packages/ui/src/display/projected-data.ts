import {
  builderKeySchema,
  moduleFieldValueSchemas,
  fieldIdSchema,
  richTextDocumentSchema,
  timestampSchema,
  isSafeLinkAddress,
  type BoardColumnSelector,
  type BlockPropertyValueContract,
  type ComponentSemanticEventKind,
  type PipelineStageTone,
  type RecordsTableFeatureProjection,
  type RecordsTableRowFormat,
  type RecordsTableFilterValue,
  type RecordsTableSortKey,
  type RecordsTableSortState,
  RECORDS_TABLE_MAXIMUM_SORT_KEYS,
  gridLayoutStateSchema,
  type GridLayout,
  type GridLayoutState,
  isRecord,
} from "@vortex/platform/schema";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "../definition-error";
import { parseRowFormat } from "./projected-format";
import {
  parseTableFeatures,
  parseTableNarrowing,
  parseTableSelectionParts,
  type TableSelectionParts,
} from "./projected-grid-features";

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
export type DisplayCellValue = DisplayScalarCellValue | DisplayTableFieldValue;

/**
 * A table field's rows on a record detail: its declared columns with readable headings, the first
 * page of rows with each row's scalar cells keyed by exactly those columns, and the field's total
 * row count, never fewer than the rows shown.
 */
export type DisplayTableFieldValue = Readonly<{
  kind: "field_table";
  columns: readonly DisplayColumn[];
  rows: readonly Readonly<Record<string, DisplayScalarCellValue>>[];
  rowCount: number;
}>;

/** One display value that is not itself a table. */
export type DisplayScalarCellValue =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "number"; value: number; formatted?: string }>
  | Readonly<{ kind: "boolean"; value: boolean }>
  | Readonly<{ kind: "date"; iso: string }> // ISO calendar date or offset timestamp
  | Readonly<{ kind: "choice"; key: string; label: string }>
  | Readonly<{ kind: "link"; address: string; label: string }>
  | Readonly<{ kind: "rich_text"; document: DisplayRichTextDocument }>
  | Readonly<{ kind: "record_link"; label: string; href?: string }> // href is an address in this application
  | Readonly<{ kind: "restricted" }> // a linked record the viewer may not read
  | Readonly<{ kind: "unavailable" }> // a linked record whose label could not be read
  | Readonly<{ kind: "empty" }>;

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
  cells: Readonly<Record<string, DisplayCellValue>>;
  /** The style keys and measures the table's formatting gives the row, decided on the server. */
  format?: RecordsTableRowFormat;
}>;

/** One declared table column; only declared columns are ever rendered. */
export type DisplayColumn = Readonly<{ key: string; label: string }>;

/** One labelled record-detail field. */
export type DisplayField = Readonly<{ key: string; label: string; value: DisplayCellValue }>;

/** One summary-block aggregate, which may be unavailable on its own. */
export type DisplaySummaryMetric = Readonly<{
  key: string;
  label: string;
  value: DisplayCellValue | Readonly<{ kind: "unavailable" }>;
}>;

/** The ready values a plain-text block renders. */
export type TextPayload = Readonly<{ kind: "text"; value: DisplayCellValue }>;

/** The ready values a structured rich-text block renders. */
export type RichTextPayload = Readonly<{ kind: "rich_text"; document: DisplayRichTextDocument }>;

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
   * The search and filters the page was read with; the table shows them in its controls and tells
   * a page that matched nothing apart from a table with no records.
   */
  narrowing?: TableNarrowing;
  page?: number;
  pageCount?: number;
  hasNextPage?: boolean;
  nextContinuationToken?: string;
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

/** The ready values a summary-values block renders. */
export type SummaryPayload = Readonly<{
  kind: "summary_values";
  values: readonly DisplaySummaryMetric[];
}>;

/** One fetched page of cards in a protected board bucket. */
export type BoardPage = Readonly<{
  rows: readonly Readonly<{
    recordId: string;
    revision: number;
    capabilities: DisplayRowCapabilities;
    /** Only currently readable declared card fields are present, each with its safe label. */
    fields: readonly DisplayField[];
  }>[];
  nextContinuationToken?: string;
}>;

/** Exact current protected totals plus a bounded page, or null when this bucket was untouched. */
export type BoardBucketPayload = Readonly<{
  rowCount: number;
  aggregates: readonly DisplaySummaryMetric[];
  page: BoardPage | null;
}>;

/**
 * One installed choice column in its pipeline's stage order: its colour role from the theme, the
 * stages a card in it may move to, and the named action that owns it, if one does.
 */
export type BoardColumnPayload = BoardBucketPayload &
  Readonly<{
    value: string;
    label: string;
    tone: PipelineStageTone;
    moves: readonly string[];
    gatedBy?: string;
  }>;

/** The ready values a query-bound board block renders. */
export type BoardPayload = Readonly<{
  kind: "board";
  title?: string;
  plan: Readonly<{
    moduleRootId: string;
    moduleReleaseVersion: string;
    queryId: string;
  }>;
  choiceFieldId: string;
  /** The key a card move names the choice field by when it asks for the record to be saved. */
  choiceFieldKey: string;
  choiceFieldRequired: boolean;
  cardTitleFieldId: string;
  /** The only field identities a card may carry; readable values and labels may be omitted. */
  cardFieldIds: readonly string[];
  totalRowCount: number;
  aggregates: readonly DisplaySummaryMetric[];
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

/** Fixed, data-free refusal reasons; a refused state never carries a value. */
export type DisplayRefusalReason = "not_permitted" | "access_ended" | "not_found";

/**
 * Explicit, data-safe state for one placement, parameterised by that block's own ready values.
 * Only the `ready` state carries values; loading, empty, refused and error cannot leak data. Each
 * block names its own state type, so no closed union of every accepted payload exists centrally.
 */
export type DisplayDataState<Values> =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "empty" }>
  /** A required query input has no value yet: the authored or fixed message, no query was run. */
  | Readonly<{ status: "awaiting_input"; message: string }>
  | Readonly<{ status: "refused"; reason: DisplayRefusalReason }>
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "ready"; values: Values }>;

/** Declared semantic event names this display family can emit. */
export type DisplaySemanticEventName =
  | Extract<
      ComponentSemanticEventKind,
      | "refresh"
      | "row_clicked"
      | "row_action"
      | "selection_changed"
      | "filter_changed"
      | "search_changed"
      | "sort_changed"
      | "columns_changed"
      | "page_changed"
      | "bulk_action"
      | "inline_edit"
      | "card_moved"
      | "row_expanded"
    >
  /**
   * A Records table's link filter asks the page for one bounded page of the field's target
   * records, and its Bulk actions widen or clear the selection; neither is a flow event.
   */
  | "filter_records_requested"
  | "selection_scope_changed";

/**
 * One declared semantic event. Row and item events always carry stable identity;
 * no event is ever emitted without a real user interaction. The bound flow, not the
 * component, decides what a row action does.
 *
 * A row click, row action, bulk action and inline-edit commit carry the stable `eventId` of the
 * exact configured control that fired, because one table placement may declare several named
 * commands that each bind to a different flow. Other displays with a single placement-level
 * action emit `row_action` without an event identity.
 *
 * A row action carries the row's server-projected current revision, exactly as an inline-edit commit
 * does, so a command that changes one existing row is bound at the revision the person actually saw
 * and the server still refuses a stale one. The value is never typed by the person.
 */
export type DisplaySemanticEvent =
  | Readonly<{ event: "refresh" }>
  | Readonly<{ event: "row_clicked"; eventId: string; recordId: string }>
  | Readonly<{
      event: "row_action";
      eventId?: string;
      recordId: string;
      /** The record revision the row was read at; a stale one is refused by the server. */
      revision?: number;
    }>
  | Readonly<{ event: "selection_changed"; recordId: string; selected: boolean }>
  | Readonly<{
      event: "filter_changed";
      /** The filterable field whose control changed. */
      field: string;
      /** The address spelling of the field's typed filter; empty clears that field's filter. */
      value: string;
    }>
  | Readonly<{
      event: "filter_records_requested";
      /** The link filter field whose target records the picker offers. */
      field: string;
      search?: string;
      continuationToken?: string;
    }>
  | Readonly<{ event: "search_changed"; query: string }>
  | Readonly<{
      /** The whole ordered sort a header asked for; an empty list asks for the default order. */
      event: "sort_changed";
      sort: readonly RecordsTableSortKey[];
    }>
  | Readonly<{
      /**
       * A person committed a change to the grid's layout (order, shown columns, widths, density).
       * The host stores it, reading no records; its handler resolves to a `GridLayoutCommitResult`.
       */
      event: "columns_changed";
      /** The layout to store, or null to remove the person's layout (Reset layout). */
      layout: GridLayout | null;
      /** The stored revision the change was made from; null when none is stored. */
      expectedRevision: number | null;
      /** The query the grid reads, as the page carried it. */
      queryId: string;
    }>
  | Readonly<{
      event: "page_changed";
      page: number;
      direction: "first" | "previous" | "next" | "last";
      continuationToken?: string;
    }>
  | Readonly<{
      event: "page_changed";
      column: BoardColumnSelector;
      continuationToken: string;
    }>
  /** Runs a declared bulk named action over the selection the page holds for the table. */
  | Readonly<{ event: "bulk_action"; action: string }>
  /** Widens the selection to every matching record, or clears it (and a finished run's summary). */
  | Readonly<{ event: "selection_scope_changed"; scope: "matching" | "cleared" }>
  | Readonly<{
      event: "inline_edit";
      eventId: string;
      recordId: string;
      /** The record revision the editor read; a stale one is refused by the server. */
      revision?: number;
      field: string;
      value: DisplayCellValue;
    }>
  | Readonly<{
      /**
       * A board card dropped into another column. It carries the record, the revision the card was
       * read at, the key of the board's choice field and the target column's option value; the
       * bound flow saves that field through the normal record save.
       */
      event: "card_moved";
      recordId: string;
      revision?: number;
      field: string;
      value: string;
    }>
  | Readonly<{
      /**
       * A person expanded a row (or asked for more of its related records). The host reads one page
       * of that row's related records on the server; its handler resolves to that page.
       */
      event: "row_expanded";
      recordId: string;
      /** The token of the page before, to read the next page; absent for the first page. */
      continuationToken?: string;
    }>;

/** A handler may return the promise of the flow it started; the control stays busy until it settles. */
export type DisplayEventHandler = (event: DisplaySemanticEvent) => void | Promise<unknown>;

/** Callbacks accepted by one placement, keyed only by declared event name. */
export type DisplayEventHandlers = Readonly<
  Partial<Record<DisplaySemanticEventName, DisplayEventHandler>>
>;

const DISPLAY_REFUSAL_REASONS: readonly DisplayRefusalReason[] = [
  "not_permitted",
  "access_ended",
  "not_found",
];

/** Every event name a display block accepts; each block further narrows this to its own binding. */
export const DISPLAY_EVENT_NAMES: readonly DisplaySemanticEventName[] = Object.freeze([
  "refresh",
  "row_clicked",
  "row_action",
  "selection_changed",
  "filter_changed",
  "filter_records_requested",
  "search_changed",
  "sort_changed",
  "columns_changed",
  "page_changed",
  "bulk_action",
  "selection_scope_changed",
  "inline_edit",
  "card_moved",
  "row_expanded",
]);

// The data-free states carry no values, so one frozen instance serves every block's state type.
const LOADING_STATE: DisplayDataState<never> = Object.freeze({ status: "loading" });
const EMPTY_STATE: DisplayDataState<never> = Object.freeze({ status: "empty" });
const ERROR_STATE: DisplayDataState<never> = Object.freeze({ status: "error" });
const EMPTY_CELL: DisplayScalarCellValue = Object.freeze({ kind: "empty" });
const RESTRICTED_CELL: DisplayScalarCellValue = Object.freeze({ kind: "restricted" });
const UNAVAILABLE_CELL: DisplayScalarCellValue = Object.freeze({ kind: "unavailable" });

/** An address inside this application: an absolute path, never another origin or a script. */
export const isInternalAddress = (value: unknown): value is string =>
  typeof value === "string" && /^\/(?![/\\])\S*$/.test(value);

/** A web link opens in a new page; a mail or telephone link hands over to the viewer's own app. */
export const isWebLinkAddress = (value: string): boolean => /^https?:/i.test(value);
const EMPTY_HANDLERS: DisplayEventHandlers = Object.freeze({});
const ISO_CALENDAR_DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const isValidIsoCalendarDate = (text: string): boolean => {
  if (!ISO_CALENDAR_DATE.test(text)) return false;
  const [year, month, day] = text.split("-").map(Number) as [number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
};

/** @internal Shared with the board payload parser. */
export function fail(
  message: string,
  location: DefinitionRenderErrorLocation,
  propertyPath?: readonly string[],
): never {
  throw new DefinitionRenderError(
    "INVALID_COMPOSITION",
    message,
    propertyPath === undefined ? location : { ...location, propertyPath },
  );
}

/** @internal Shared with the board payload parser. */
export const requireRecord = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): Record<string, unknown> => (isRecord(value) ? value : fail(message, location));

/** @internal Shared with the board payload parser. */
export const requireExactKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: DefinitionRenderErrorLocation,
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`Unexpected projected display field '${key}'`, location);
  }
};

/** @internal Shared with the board payload parser. */
export const requireString = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => (typeof value === "string" ? value : fail(message, location));

/** @internal Shared with the board payload parser. */
export const requireNonEmptyString = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => {
  const text = requireString(value, message, location);
  return text.trim().length > 0 ? text : fail(message, location);
};

/** @internal Shared with the board payload parser. */
export const requireArray = (
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

/** A row cell, column, detail field or sort key: a builder key or a declared field identity. */
export const requireFieldKey = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => {
  const parsed = builderKeySchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const field = fieldIdSchema.safeParse(value);
  return field.success ? field.data : fail(message, location);
};

/** @internal Shared with the board payload parser. */
export const requirePositiveInteger = (
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
): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fail(message, location);

const parseRichTextDocument = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): DisplayRichTextDocument => {
  const parsed = richTextDocumentSchema.safeParse(value);
  return parsed.success
    ? (parsed.data as DisplayRichTextDocument)
    : fail("Projected rich text must satisfy the structured rich-text contract", location);
};

const parseCellValue = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): DisplayScalarCellValue => {
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
    case "choice": {
      requireExactKeys(record, ["kind", "key", "label"], location);
      const key = moduleFieldValueSchemas.choice.safeParse(record.key);
      if (!key.success)
        return fail("A choice display value requires a valid stored value", location);
      return Object.freeze({
        kind: "choice",
        key: key.data,
        label: requireNonEmptyString(
          record.label,
          "A choice display value requires a label",
          location,
        ),
      });
    }
    case "link": {
      requireExactKeys(record, ["kind", "address", "label"], location);
      return isSafeLinkAddress(record.address)
        ? Object.freeze({
            kind: "link",
            address: record.address,
            label: requireNonEmptyString(
              record.label,
              "A link display value requires a label",
              location,
            ),
          })
        : fail("A link display value requires a safe web, mail or telephone address", location);
    }
    case "rich_text":
      requireExactKeys(record, ["kind", "document"], location);
      return Object.freeze({
        kind: "rich_text",
        document: parseRichTextDocument(record.document, location),
      });
    case "record_link": {
      const label = requireNonEmptyString(
        record.label,
        "A record link display value requires a label",
        location,
      );
      if (record.href === undefined) {
        requireExactKeys(record, ["kind", "label"], location);
        return Object.freeze({ kind: "record_link", label });
      }
      requireExactKeys(record, ["kind", "label", "href"], location);
      return isInternalAddress(record.href)
        ? Object.freeze({ kind: "record_link", label, href: record.href })
        : fail("A record link display value requires an address inside this application", location);
    }
    case "restricted":
      requireExactKeys(record, ["kind"], location);
      return RESTRICTED_CELL;
    case "unavailable":
      requireExactKeys(record, ["kind"], location);
      return UNAVAILABLE_CELL;
    case "empty":
      requireExactKeys(record, ["kind"], location);
      return EMPTY_CELL;
    default:
      return fail(`Unknown projected display value kind '${String(record.kind)}'`, location);
  }
};

/**
 * A record-detail field value: a scalar value, or a table field's rows. A table's columns are
 * distinct and labelled, and every row carries exactly those column keys, each a scalar value; a
 * nested table, an unknown row key and a missing cell are refused.
 */
const parseDetailFieldValue = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): DisplayCellValue => {
  if (!isRecord(value) || value.kind !== "field_table") return parseCellValue(value, location);
  requireExactKeys(value, ["kind", "columns", "rows", "rowCount"], location);
  const columns = parseColumns(value.columns, location);
  if (columns.length === 0) fail("A table field value requires its declared columns", location);
  const keys = columns.map((column) => column.key);
  const rows = requireArray(value.rows, "A table field value requires its rows", location).map(
    (row, index) => {
      const rowLocation = { ...location, propertyPath: [`rows[${index}]`] };
      const cells = requireRecord(row, "A table field row must be an object", rowLocation);
      requireExactKeys(cells, keys, rowLocation);
      return Object.freeze(
        Object.fromEntries(
          keys.map((key) => {
            if (!Object.prototype.hasOwnProperty.call(cells, key))
              fail(`A table field row requires a cell for column '${key}'`, rowLocation);
            return [key, parseCellValue(cells[key], { ...rowLocation, propertyPath: [key] })];
          }),
        ),
      );
    },
  );
  const rowCount = value.rowCount;
  if (typeof rowCount !== "number" || !Number.isSafeInteger(rowCount) || rowCount < rows.length)
    fail("A table field value requires its total row count", location);
  return Object.freeze({ kind: "field_table", columns, rows: Object.freeze(rows), rowCount });
};

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
        ["recordId", "revision", "capabilities", "cells", "format"],
        rowLocation,
      );
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
      const format =
        record.format === undefined
          ? undefined
          : parseRowFormat(record.format, {
              ...rowLocation,
              propertyPath: [`rows[${index}]`, "format"],
            });
      return Object.freeze({
        recordId,
        ...(revision === undefined ? {} : { revision }),
        ...(capabilities === undefined ? {} : { capabilities }),
        cells: Object.freeze(cells),
        ...(format === undefined ? {} : { format }),
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
      if (seen.has(recordId)) fail(`Duplicate selected record identity '${recordId}'`, location);
      seen.add(recordId);
      return recordId;
    }),
  );
};

const parseSummaryValue = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): DisplaySummaryMetric["value"] => {
  if (isRecord(value) && value.kind === "unavailable") {
    requireExactKeys(value, ["kind"], location);
    return Object.freeze({ kind: "unavailable" });
  }
  return parseCellValue(value, location);
};

const parseSummaryEntries = <Value>(
  value: unknown,
  location: DefinitionRenderErrorLocation,
  parseValue: (value: unknown, location: DefinitionRenderErrorLocation) => Value,
): readonly Readonly<{ key: string; label: string; value: Value }>[] => {
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
        value: parseValue(record.value, summaryLocation),
      });
    }),
  );
};

/** @internal Shared with the board payload parser. */
export const parseSummaryMetrics = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): readonly DisplaySummaryMetric[] => parseSummaryEntries(value, location, parseSummaryValue);

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
export const parseTextPayload = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): TextPayload => {
  const record = requireRecord(value, "Projected display values must be an object", location);
  if (record.kind !== "text")
    return fail(`Expected 'text' projected values, got '${String(record.kind)}'`, location);
  requireExactKeys(record, ["kind", "value"], location);
  return Object.freeze({ kind: "text", value: parseCellValue(record.value, location) });
};

/** The ready values a structured rich-text block accepts. */
export const parseRichTextPayload = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): RichTextPayload => {
  const record = requireRecord(value, "Projected display values must be an object", location);
  if (record.kind !== "rich_text")
    return fail(`Expected 'rich_text' projected values, got '${String(record.kind)}'`, location);
  requireExactKeys(record, ["kind", "document"], location);
  return Object.freeze({
    kind: "rich_text",
    document: parseRichTextDocument(record.document, location),
  });
};

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
      "columns",
      "hiddenColumns",
      "layout",
      "rows",
      "features",
      "selectedRecordIds",
      "sort",
      "narrowing",
      "page",
      "pageCount",
      "hasNextPage",
      "nextContinuationToken",
      "hasPreviousPage",
      "previousContinuationToken",
      "selectionToken",
      "selectionScope",
      "bulkRun",
    ],
    location,
  );
  // A column is either shown or hidden, never both.
  const seenColumns = new Set<string>();
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
  const selection = parseSelection(record.selectedRecordIds, rows, location);
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
  let sort: RecordsTableSortState | undefined;
  if (record.sort !== undefined) {
    const sortRecord = requireRecord(record.sort, "Projected sort is invalid", location);
    requireExactKeys(sortRecord, ["keys", "explicit"], location);
    if (typeof sortRecord.explicit !== "boolean")
      fail("A projected sort must say whether the viewer chose it", location);
    const items = requireArray(sortRecord.keys, "Projected sort keys must be an array", location);
    if (items.length === 0 || items.length > RECORDS_TABLE_MAXIMUM_SORT_KEYS)
      fail("A projected sort holds between one and twenty keys", location);
    const keys = items.map((item): RecordsTableSortKey => {
      const key = requireRecord(item, "A projected sort key must be an object", location);
      requireExactKeys(key, ["fieldId", "direction"], location);
      const fieldId = requireFieldKey(
        key.fieldId,
        "A projected sort key requires a field",
        location,
      );
      if (key.direction !== "ascending" && key.direction !== "descending")
        fail("A projected sort direction must be ascending or descending", location);
      return Object.freeze({ fieldId, direction: key.direction });
    });
    if (new Set(keys.map((key) => key.fieldId.toLowerCase())).size !== keys.length)
      fail("A projected sort names each field once", location);
    sort = Object.freeze({ keys: Object.freeze(keys), explicit: sortRecord.explicit });
  }
  const narrowing =
    record.narrowing === undefined ? undefined : parseTableNarrowing(record.narrowing, location);
  const features =
    record.features === undefined ? undefined : parseTableFeatures(record.features, location);
  const selectionParts = parseTableSelectionParts(record, location);
  return Object.freeze({
    kind: "table",
    columns,
    hiddenColumns,
    layout: layout.data,
    rows,
    ...(features === undefined ? {} : { features }),
    ...selectionParts,
    ...(selection === undefined ? {} : { selectedRecordIds: selection }),
    ...(sort === undefined ? {} : { sort }),
    ...(narrowing === undefined ? {} : { narrowing }),
    ...(page === undefined ? {} : { page }),
    ...(pageCount === undefined ? {} : { pageCount }),
    ...(hasNextPage === undefined ? {} : { hasNextPage }),
    ...(nextContinuationToken === undefined ? {} : { nextContinuationToken }),
    ...(hasPreviousPage === undefined ? {} : { hasPreviousPage }),
    ...(previousContinuationToken === undefined ? {} : { previousContinuationToken }),
  });
};

/** The ready values a calendar block accepts. */
export const parseCalendarPayload = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): CalendarPayload => {
  const record = requireRecord(value, "Projected display values must be an object", location);
  if (record.kind !== "calendar")
    return fail(`Expected 'calendar' projected values, got '${String(record.kind)}'`, location);
  requireExactKeys(
    record,
    [
      "kind",
      "view",
      "date",
      "windowStart",
      "windowEnd",
      "timeZone",
      "endExclusive",
      "truncated",
      "items",
    ],
    location,
  );
  const calendarDate = (candidate: unknown, message: string): string => {
    const text = requireNonEmptyString(candidate, message, location);
    if (!isValidIsoCalendarDate(text)) return fail(message, location);
    return text;
  };
  const dateOrTimestamp = (candidate: unknown, message: string): string => {
    const text = requireNonEmptyString(candidate, message, location);
    const date = isValidIsoCalendarDate(text);
    if (!date && !timestampSchema.safeParse(text).success) return fail(message, location);
    return text;
  };
  const view = record.view;
  if (view !== "month" && view !== "week" && view !== "agenda")
    return fail("A calendar view must be month, week or agenda", location);
  const date = calendarDate(record.date, "A calendar requires an ISO date");
  const windowStart = calendarDate(record.windowStart, "A calendar requires a window start date");
  const windowEnd = calendarDate(record.windowEnd, "A calendar requires a window end date");
  if (windowStart >= windowEnd)
    return fail("A calendar window must have positive length", location);
  const timeZone = requireNonEmptyString(
    record.timeZone,
    "A calendar requires a time zone",
    location,
  );
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(0);
  } catch {
    return fail("A calendar time zone must be supported", location);
  }
  if (typeof record.truncated !== "boolean")
    return fail("A calendar requires a truncation flag", location);
  if (typeof record.endExclusive !== "boolean")
    return fail("A calendar requires an end boundary rule", location);
  const seen = new Set<string>();
  const items = requireArray(record.items, "Calendar items must be an array", location).map(
    (candidate): CalendarItemPayload => {
      const item = requireRecord(candidate, "A calendar item must be an object", location);
      requireExactKeys(item, ["recordId", "start", "end", "title"], location);
      const recordId = requireNonEmptyString(
        item.recordId,
        "A calendar item requires a record identity",
        location,
      );
      const normalizedRecordId = recordId.toLowerCase();
      if (seen.has(normalizedRecordId)) fail("Each calendar record appears once", location);
      seen.add(normalizedRecordId);
      const start = dateOrTimestamp(item.start, "A calendar item requires a valid start");
      const end =
        item.end === null ? null : dateOrTimestamp(item.end, "A calendar item end must be valid");
      if (end !== null && isValidIsoCalendarDate(start) !== isValidIsoCalendarDate(end))
        fail("A calendar item start and end must use the same date precision", location);
      return Object.freeze({
        recordId,
        start,
        end,
        title: requireString(item.title, "A calendar item requires a title", location),
      });
    },
  );
  return Object.freeze({
    kind: "calendar",
    view,
    date,
    windowStart,
    windowEnd,
    timeZone,
    endExclusive: record.endExclusive,
    truncated: record.truncated,
    items: Object.freeze(items),
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
export const parseSummaryPayload = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): SummaryPayload => {
  const record = requireRecord(value, "Projected display values must be an object", location);
  if (record.kind !== "summary_values")
    return fail(
      `Expected 'summary_values' projected values, got '${String(record.kind)}'`,
      location,
    );
  requireExactKeys(record, ["kind", "values"], location);
  return Object.freeze({
    kind: "summary_values",
    values: parseSummaryMetrics(record.values, location),
  });
};

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
  const record = requireRecord(value, "Projected display data must be an object", location);
  switch (record.status) {
    case "loading":
      requireExactKeys(record, ["status"], location);
      return LOADING_STATE;
    case "empty":
      requireExactKeys(record, ["status"], location);
      return EMPTY_STATE;
    case "awaiting_input": {
      requireExactKeys(record, ["status", "message"], location);
      const message = record.message;
      if (typeof message !== "string" || message.trim() === "" || message.length > 300)
        return fail("An awaiting display state must carry its message", location);
      return Object.freeze({ status: "awaiting_input", message });
    }
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
    case "error":
      requireExactKeys(record, ["status"], location);
      return ERROR_STATE;
    case "ready":
      requireExactKeys(record, ["status", "values"], location);
      return Object.freeze({
        status: "ready",
        values: parseValues(record.values, location),
      });
    default:
      return fail(`Unknown projected display status '${String(record.status)}'`, location);
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
