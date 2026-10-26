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

const DATA_STATUSES: ReadonlySet<string> = new Set([
  "loading",
  "empty",
  "awaiting_input",
  "refused",
  "error",
  "ready",
]);

/**
 * One block's projected state. The renderer checks the envelope: an object with a known status, and
 * values only in the ready state. The values are the payload the server built with its typed
 * projection from reads it validated; the renderer does not parse them again, in the server render
 * or in the browser. A block whose values carry what the browser itself must refuse (a closed
 * disclosure shape, a link target, a time zone it cannot show) names `readValues` for that check.
 * Throws a located definition error for any other envelope.
 */
export const readDisplayData = <Values>(
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
  readValues?: (values: unknown, location: DefinitionRenderErrorLocation) => Values,
): DisplayDataState<Values> => {
  const state = requireRecord(value, "Projected display data must be an object", location);
  const status = state.status;
  if (typeof status !== "string" || !DATA_STATUSES.has(status))
    return fail("Projected display data has an unknown status", location, ["status"]);
  switch (status) {
    case "loading":
      return LOADING_STATE;
    case "empty":
      return EMPTY_STATE;
    case "error":
      return ERROR_STATE;
    case "ready":
      if (!Object.hasOwn(state, "values"))
        return fail("Ready display data carries its values", location, ["values"]);
      return readValues === undefined
        ? (state as DisplayDataState<Values>)
        : Object.freeze({ status: "ready", values: readValues(state.values, location) });
    default:
      return state as DisplayDataState<Values>;
  }
};

/**
 * One read a grid feature asked its host for (a tree level, a group's members, related records, a
 * pivot page), as the server returned it: an object with a status. Like a block's ready values, its
 * content is the server's typed reply and is not parsed again here.
 */
export const readProjectedResult = <Result extends Readonly<{ status: string }>>(
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): Result => {
  const result = requireRecord(value, message, location);
  if (typeof result.status !== "string") return fail(message, location, ["status"]);
  return result as Result;
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
