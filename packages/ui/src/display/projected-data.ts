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
import { displayRefusalReasons } from "@vortex/platform/schema";
import type {
  RichTextPayload,
  TextPayload,
  SummaryPayload,
  RecordDetailPayload,
  LauncherRowsPayload,
  DisplayDataState,
  BlockPropertyValueContract,
  DisplayTablePayload,
  BoardPayload,
} from "@vortex/platform/schema";
import type { DefinitionRenderErrorLocation } from "../definition-error";
import { fail, requireRecord } from "./payload-parse";

export {
  isInternalAddress,
  type BoardBucketPayload,
  type BoardColumnPayload,
  type BoardPage,
  type BoardPayload,
  type CalendarPayload,
  type CalendarView,
  type DisplayColumn,
  type DisplayDataState,
  type DisplayDetailCell,
  type DisplayDetailField,
  type DisplayRefusalReason,
  type DisplayRow,
  type DisplayScalarCell,
  type DisplaySummaryMetric,
  type DisplayTableBulkRun,
  type DisplayTableExportRun,
  type DisplayTableExportScope,
  type DisplayTableField,
  type DisplayTableGroup,
  type DisplayTableGroups,
  type DisplayTableNarrowing,
  type DisplayTablePayload,
  type DisplayTableSelectionScope,
  type LauncherRowsPayload,
  type RecordDetailPayload,
  type RecordsTableBulkRunSummary,
  type RichTextPayload,
  type SummaryPayload,
  type TextPayload,
} from "@vortex/platform/schema";

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

export type TextData = DisplayDataState<TextPayload>;
export type RichTextData = DisplayDataState<RichTextPayload>;
export type LauncherRowsData = DisplayDataState<LauncherRowsPayload>;
export type TableData = DisplayDataState<DisplayTablePayload>;
export type RecordDetailData = DisplayDataState<RecordDetailPayload>;
export type SummaryData = DisplayDataState<SummaryPayload>;
export type BoardData = DisplayDataState<BoardPayload>;

// The data-free states carry no values, so one frozen instance serves every block's state type.
const LOADING_STATE: DisplayDataState<never> = Object.freeze({ status: "loading" });
const EMPTY_STATE: DisplayDataState<never> = Object.freeze({ status: "empty" });
const ERROR_STATE: DisplayDataState<never> = Object.freeze({ status: "error" });

/** A web link opens in a new page; a mail or telephone link hands over to the viewer's own app. */
export const isWebLinkAddress = (value: string): boolean => /^https?:/i.test(value);

/** Text a closed envelope carries: more than white space, within its bound. */
const isBoundedText = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= maximum;

/** The keys one status of a closed envelope carries: each required key, and only those allowed. */
type EnvelopeShape = Readonly<{
  required: readonly string[];
  optional?: readonly string[];
  check?: (record: Readonly<Record<string, unknown>>) => boolean;
}>;

const STATUS_ONLY: EnvelopeShape = Object.freeze({ required: [] });

/**
 * Checks a closed envelope from the server: an object whose status is one of the given ones, with
 * exactly that status's keys and their own small checks. The content of a ready envelope is the
 * payload the server validated where it built it, so it is not parsed again here.
 */
const readEnvelope = (
  value: unknown,
  shapes: Readonly<Record<string, EnvelopeShape>>,
  message: string,
  location: DefinitionRenderErrorLocation,
): Readonly<Record<string, unknown>> => {
  const record = requireRecord(value, message, location);
  const status = record.status;
  const shape =
    typeof status === "string" && Object.hasOwn(shapes, status) ? shapes[status] : undefined;
  if (shape === undefined) return fail(`${message}: unknown status`, location, ["status"]);
  const allowed = new Set(["status", ...shape.required, ...(shape.optional ?? [])]);
  for (const key of Object.keys(record))
    if (!allowed.has(key)) return fail(`${message}: unexpected '${key}'`, location, [key]);
  for (const key of shape.required)
    if (!Object.hasOwn(record, key)) return fail(`${message}: missing '${key}'`, location, [key]);
  if (shape.check !== undefined && !shape.check(record)) return fail(message, location);
  return record;
};

const DISPLAY_STATE_SHAPES: Readonly<Record<string, EnvelopeShape>> = Object.freeze({
  loading: STATUS_ONLY,
  empty: STATUS_ONLY,
  error: STATUS_ONLY,
  awaiting_input: {
    required: ["message"],
    check: (state) => isBoundedText(state.message, 300),
  },
  refused: {
    required: ["reason"],
    check: (state) =>
      typeof state.reason === "string" &&
      (displayRefusalReasons as readonly string[]).includes(state.reason),
  },
  ready: { required: ["values"] },
});

/**
 * One block's projected state. The renderer checks the closed envelope: a known status with exactly
 * its own keys, a refusal reason the platform names and a bounded awaiting-input message; only the
 * ready state carries values. The values are the payload the server checked against the block's
 * contract where it built it; the renderer does not parse them again, in the server render or in
 * the browser. A block whose values carry what the browser itself must refuse (a closed disclosure
 * shape, a link target, a time zone it cannot show) names `readValues` for that check.
 */
export const readDisplayData = <Values>(
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
  readValues?: (values: unknown, location: DefinitionRenderErrorLocation) => Values,
): DisplayDataState<Values> => {
  const state = readEnvelope(
    value,
    DISPLAY_STATE_SHAPES,
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
      return readValues === undefined
        ? (state as DisplayDataState<Values>)
        : Object.freeze({ status: "ready", values: readValues(state.values, location) });
    default:
      return state as DisplayDataState<Values>;
  }
};

/** A tree level's or a group's members reply: the table's ready values, or a bare status. */
const TABLE_LEVEL_SHAPES: Readonly<Record<string, EnvelopeShape>> = Object.freeze({
  ready: { required: ["values"] },
  empty: STATUS_ONLY,
  refused: STATUS_ONLY,
  error: STATUS_ONLY,
});

/** A related-records reply: its columns and rows, or a bare status that carries nothing. */
const ROW_DETAIL_SHAPES: Readonly<Record<string, EnvelopeShape>> = Object.freeze({
  ready: {
    required: ["columns", "rows"],
    optional: ["nextContinuationToken"],
    check: (reply) => Array.isArray(reply.columns) && Array.isArray(reply.rows),
  },
  empty: STATUS_ONLY,
  refused: STATUS_ONLY,
  error: STATUS_ONLY,
});

/** A pivot page reply, or a refusal with its message, or a bare status. */
const PIVOT_SHAPES: Readonly<Record<string, EnvelopeShape>> = Object.freeze({
  ready: {
    required: [
      "rowLabel",
      "columnLabel",
      "measureLabel",
      "columns",
      "rows",
      "totalRecords",
      "rowGroupCount",
    ],
    optional: ["columnTotals", "grandTotal", "nextCursor"],
    check: (reply) => Array.isArray(reply.columns) && Array.isArray(reply.rows),
  },
  empty: STATUS_ONLY,
  refused: {
    required: ["message"],
    check: (reply) => isBoundedText(reply.message, Number.MAX_SAFE_INTEGER),
  },
  error: STATUS_ONLY,
});

/** One read a grid feature asked its host for, by the reply's own closed envelope. */
export const REPLY_ENVELOPES = Object.freeze({
  tableLevel: TABLE_LEVEL_SHAPES,
  rowDetail: ROW_DETAIL_SHAPES,
  pivot: PIVOT_SHAPES,
});

/**
 * One read a grid feature asked its host for (a tree level, a group's members, related records, a
 * pivot page), as the server returned it: its closed envelope is checked here; its content is the
 * reply the server checked against its contract where it built it.
 */
export const readProjectedResult = <Result extends Readonly<{ status: string }>>(
  value: unknown,
  envelope: Readonly<Record<string, EnvelopeShape>>,
  message: string,
  location: DefinitionRenderErrorLocation,
): Result => readEnvelope(value, envelope, message, location) as unknown as Result;

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
