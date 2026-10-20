import { PLATFORM_BLOCK_RELEASE_IDENTITIES } from "@vortex/platform/schema";
import {
  createPayloadParser,
  noRuntimeInputs,
  type PlatformComponentPayloadParser,
  type PlatformComponentRegistration,
} from "../registry";
import type { DefinitionRenderErrorLocation } from "../definition-error";
import { parseBoardPayload } from "./board-payload";
import {
  parseCalendarPayload,
  parseDisplayData,
  parseDisplayEventHandlers,
  parseRecordDetailPayload,
  parseRichTextPayload,
  parseSummaryPayload,
  parseTablePayload,
  parseTextPayload,
  type CalendarPayload,
  type BoardPayload,
  type RecordDetailPayload,
  type RichTextPayload,
  type SummaryPayload,
  type TablePayload,
  type TextPayload,
} from "./projected-data";
import { QUERY_NOTICE_PAYLOAD_PARSER } from "./query-notice";

/**
 * The parser a display block's registration supplies: its own ready values under `data` and its own
 * declared semantic callbacks under `events`. Each block names one payload parser, so an accepted
 * payload shape is that block's alone and adding a data component needs no renderer change.
 */
const displayPayloadParser = <Payload>(
  parseValues: (value: unknown, location: DefinitionRenderErrorLocation) => Payload,
): PlatformComponentPayloadParser =>
  createPayloadParser({
    data: (value, location) => parseDisplayData(value, parseValues, location),
    events: (value, location) => parseDisplayEventHandlers(value, location),
  });

const TEXT_PAYLOAD_PARSER = displayPayloadParser<TextPayload>(parseTextPayload);
const RICH_TEXT_PAYLOAD_PARSER = displayPayloadParser<RichTextPayload>(parseRichTextPayload);
/**
 * The Data grid's one payload parser: the rows of a table, or the columns of a board when the
 * grid's Board feature is on. The projected `kind` says which; each kind has its own strict parser.
 */
const parseGridPayload = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): TablePayload | BoardPayload =>
  typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "board"
    ? parseBoardPayload(value, location)
    : parseTablePayload(value, location);
const TABLE_PAYLOAD_PARSER = displayPayloadParser<TablePayload | BoardPayload>(parseGridPayload);
const CALENDAR_PAYLOAD_PARSER = displayPayloadParser<CalendarPayload>(parseCalendarPayload);
const RECORD_DETAIL_PAYLOAD_PARSER =
  displayPayloadParser<RecordDetailPayload>(parseRecordDetailPayload);
const SUMMARY_VALUES_PAYLOAD_PARSER = displayPayloadParser<SummaryPayload>(parseSummaryPayload);

/** Exact registrations pairing each display block release with its React renderer. */
export const DISPLAY_COMPONENT_REGISTRATIONS: readonly PlatformComponentRegistration[] =
  Object.freeze([
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.NOTICE_BLOCK_RELEASE,
      parsePayload: noRuntimeInputs,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.QUERY_NOTICE_BLOCK_RELEASE,
      parsePayload: QUERY_NOTICE_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.TEXT_BLOCK_RELEASE,
      parsePayload: TEXT_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.RICH_TEXT_BLOCK_RELEASE,
      parsePayload: RICH_TEXT_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.RECORD_DETAIL_BLOCK_RELEASE,
      parsePayload: RECORD_DETAIL_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.SUMMARY_VALUES_BLOCK_RELEASE,
      parsePayload: SUMMARY_VALUES_PAYLOAD_PARSER,
    }),
    // The one Data grid release: its data contract, row behaviours, interactive controls and Board mode.
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.TABLE_BLOCK_RELEASE,
      parsePayload: TABLE_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.CALENDAR_BLOCK_RELEASE,
      parsePayload: CALENDAR_PAYLOAD_PARSER,
    }),
  ]);
