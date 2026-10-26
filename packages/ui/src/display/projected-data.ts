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
  richTextPayloadSchema,
  textPayloadSchema,
  type RichTextPayload,
  type TextPayload,
  type DisplaySummaryMetric,
  summaryPayloadSchema,
  type SummaryPayload,
  displayDataStateSchema,
  displayFieldsSchema,
  displayScalarCellSchema,
  recordDetailPayloadSchema,
  type RecordDetailPayload,
  launcherRowsPayloadSchema,
  type LauncherRowsPayload,
  type DisplayDataState,
  type DisplayDetailField,
  type BlockPropertyValueContract,
  tablePayloadSchema,
  type DisplayTablePayload,
  type BoardPayload,
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

/** @internal Shared with the pivot feature, whose cells are summary values. */
export const parseSummaryValue = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): DisplaySummaryMetric["value"] =>
  parseProjectedPart(
    displayScalarCellSchema,
    value,
    "A projected display value is invalid",
    location,
  );

/**
 * @internal Shared with the master-detail panel: labelled fields with scalar values. Only a record
 * detail accepts a table field's rows.
 */
export const parseFields = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): readonly DisplayDetailField[] =>
  parseProjectedPart(displayFieldsSchema, value, "Projected fields are invalid", location);

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

/** The ready rows a launcher block accepts. */
export const parseLauncherRowsPayload = projectedValuesParser(
  launcherRowsPayloadSchema,
  "Projected launcher rows are invalid",
);

/** The ready values a table block accepts. */
export const parseTablePayload = projectedValuesParser(
  tablePayloadSchema,
  "Projected table values are invalid",
);

/** The ready values a record-detail block accepts. */
export const parseRecordDetailPayload = projectedValuesParser(
  recordDetailPayloadSchema,
  "Projected record detail values are invalid",
);

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
