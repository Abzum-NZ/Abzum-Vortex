import {
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
  type PlatformBlockRelease,
} from "@vortex/platform/schema";
import {
  createPayloadParser,
  createPlatformComponentRegistry,
  noRuntimeInputs,
  type PlatformComponentPayloadParser,
  type PlatformComponentRegistration,
  type PlatformComponentRegistry,
} from "../registry";
import type { DefinitionRenderErrorLocation } from "../definition-error";
import {
  parseCalendarPayload,
  parseBoardPayload,
  parseDisplayData,
  parseDisplayEventHandlers,
  parseGroupedPayload,
  parseListPayload,
  parseRecordDetailPayload,
  parseRichTextPayload,
  parseSummaryPayload,
  parseTablePayload,
  parseTextPayload,
  type CalendarPayload,
  type BoardPayload,
  type GroupedPayload,
  type ListPayload,
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
const LIST_PAYLOAD_PARSER = displayPayloadParser<ListPayload>(parseListPayload);
const TABLE_PAYLOAD_PARSER = displayPayloadParser<TablePayload>(parseTablePayload);
const CALENDAR_PAYLOAD_PARSER = displayPayloadParser<CalendarPayload>(parseCalendarPayload);
const BOARD_PAYLOAD_PARSER = displayPayloadParser<BoardPayload>(parseBoardPayload);
const RECORD_DETAIL_PAYLOAD_PARSER =
  displayPayloadParser<RecordDetailPayload>(parseRecordDetailPayload);
const GROUPED_DATA_PAYLOAD_PARSER = displayPayloadParser<GroupedPayload>(parseGroupedPayload);
const SUMMARY_VALUES_PAYLOAD_PARSER = displayPayloadParser<SummaryPayload>(parseSummaryPayload);

/** Exact registrations pairing each display block release with its React renderer. */
export const DISPLAY_COMPONENT_REGISTRATIONS: readonly PlatformComponentRegistration[] =
  Object.freeze([
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.TEXT_BLOCK_RELEASE,
      parsePayload: TEXT_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.RICH_TEXT_BLOCK_RELEASE,
      parsePayload: RICH_TEXT_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.LIST_BLOCK_RELEASE,
      parsePayload: LIST_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.TABLE_BLOCK_RELEASE,
      parsePayload: TABLE_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.RECORD_DETAIL_BLOCK_RELEASE,
      parsePayload: RECORD_DETAIL_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.GROUPED_DATA_BLOCK_RELEASE,
      parsePayload: GROUPED_DATA_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.SUMMARY_VALUES_BLOCK_RELEASE,
      parsePayload: SUMMARY_VALUES_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.NOTICE_BLOCK_RELEASE,
      parsePayload: noRuntimeInputs,
    }),
    // Release 1.1.0 adds authored defaults only; the same parser serves both releases.
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.NOTICE_BLOCK_RELEASE_1_1_0,
      parsePayload: noRuntimeInputs,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.QUERY_NOTICE_BLOCK_RELEASE,
      parsePayload: QUERY_NOTICE_PAYLOAD_PARSER,
    }),
    // Release 1.1.0 adds the optional authored empty message; the same parser serves both releases.
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.TEXT_BLOCK_RELEASE_1_1_0,
      parsePayload: TEXT_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.RICH_TEXT_BLOCK_RELEASE_1_1_0,
      parsePayload: RICH_TEXT_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.LIST_BLOCK_RELEASE_1_1_0,
      parsePayload: LIST_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.TABLE_BLOCK_RELEASE_1_1_0,
      parsePayload: TABLE_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.RECORD_DETAIL_BLOCK_RELEASE_1_1_0,
      parsePayload: RECORD_DETAIL_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.GROUPED_DATA_BLOCK_RELEASE_1_1_0,
      parsePayload: GROUPED_DATA_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.SUMMARY_VALUES_BLOCK_RELEASE_1_1_0,
      parsePayload: SUMMARY_VALUES_PAYLOAD_PARSER,
    }),
    // Release 1.2.0 declares the data contract as settings; the same renderers and parsers read it.
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.TABLE_BLOCK_RELEASE_1_2_0,
      parsePayload: TABLE_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.RECORD_DETAIL_BLOCK_RELEASE_1_2_0,
      parsePayload: RECORD_DETAIL_PAYLOAD_PARSER,
    }),
    // Release 1.3.0 adds configured row behaviours; the same parser reads them.
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.TABLE_BLOCK_RELEASE_1_3_0,
      parsePayload: TABLE_PAYLOAD_PARSER,
    }),
    // Release 1.4.0 adds the interactive filter, search, sort, paging and selection controls and
    // each action's declared capability; the same parser reads them.
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.TABLE_BLOCK_RELEASE_1_4_0,
      parsePayload: TABLE_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.CALENDAR_BLOCK_RELEASE,
      parsePayload: CALENDAR_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.BOARD_BLOCK_RELEASE,
      parsePayload: BOARD_PAYLOAD_PARSER,
    }),
  ]);

/** Creates an immutable PlatformComponentRegistry populated with every display block release. */
export function createDisplayComponentRegistry(
  platformReleases: readonly PlatformBlockRelease[],
): PlatformComponentRegistry {
  return createPlatformComponentRegistry(DISPLAY_COMPONENT_REGISTRATIONS, platformReleases);
}
