import {
  DISPLAY_BLOCK_RELEASES,
  GROUPED_DATA_BLOCK_RELEASE,
  GROUPED_DATA_BLOCK_RELEASE_1_1_0,
  LIST_BLOCK_RELEASE,
  LIST_BLOCK_RELEASE_1_1_0,
  RECORD_DETAIL_BLOCK_RELEASE,
  RECORD_DETAIL_BLOCK_RELEASE_1_1_0,
  RECORD_DETAIL_BLOCK_RELEASE_1_2_0,
  RICH_TEXT_BLOCK_RELEASE,
  RICH_TEXT_BLOCK_RELEASE_1_1_0,
  SUMMARY_VALUES_BLOCK_RELEASE,
  SUMMARY_VALUES_BLOCK_RELEASE_1_1_0,
  TABLE_BLOCK_RELEASE,
  TABLE_BLOCK_RELEASE_1_1_0,
  TABLE_BLOCK_RELEASE_1_2_0,
  TABLE_BLOCK_RELEASE_1_3_0,
  TEXT_BLOCK_RELEASE,
  TEXT_BLOCK_RELEASE_1_1_0,
} from "@vortex/contracts";
import {
  createPayloadParser,
  createPlatformComponentRegistry,
  type PlatformComponentPayloadParser,
  type PlatformComponentRegistration,
  type PlatformComponentRegistry,
} from "../registry";
import type { DefinitionRenderErrorLocation } from "../definition-error";
import {
  parseDisplayData,
  parseDisplayEventHandlers,
  parseGroupedPayload,
  parseListPayload,
  parseRecordDetailPayload,
  parseRichTextPayload,
  parseSummaryPayload,
  parseTablePayload,
  parseTextPayload,
  type GroupedPayload,
  type ListPayload,
  type RecordDetailPayload,
  type RichTextPayload,
  type SummaryPayload,
  type TablePayload,
  type TextPayload,
} from "./projected-data";
import { GroupedDataDisplay } from "./grouped-data";
import { ListDisplay } from "./list";
import { RecordDetailDisplay } from "./record-detail";
import { RichTextDisplay } from "./rich-text-component";
import { SummaryValuesDisplay } from "./summary-values";
import { TableDisplay } from "./table";
import { PlainTextDisplay } from "./text";

/**
 * Release metadata is owned by the server-side platform block catalogue in @vortex/contracts;
 * these registrations only pair each registered release with its renderer, so a renderer
 * change cannot redefine or extend what authors may place.
 */
export {
  DISPLAY_BLOCK_RELEASES,
  GROUPED_DATA_BLOCK_RELEASE,
  LIST_BLOCK_RELEASE,
  RECORD_DETAIL_BLOCK_RELEASE,
  RICH_TEXT_BLOCK_RELEASE,
  SUMMARY_VALUES_BLOCK_RELEASE,
  TABLE_BLOCK_RELEASE,
  TEXT_BLOCK_RELEASE,
};

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
const RECORD_DETAIL_PAYLOAD_PARSER =
  displayPayloadParser<RecordDetailPayload>(parseRecordDetailPayload);
const GROUPED_DATA_PAYLOAD_PARSER = displayPayloadParser<GroupedPayload>(parseGroupedPayload);
const SUMMARY_VALUES_PAYLOAD_PARSER = displayPayloadParser<SummaryPayload>(parseSummaryPayload);

/** Exact registrations pairing each display block release with its React renderer. */
export const DISPLAY_COMPONENT_REGISTRATIONS: readonly PlatformComponentRegistration[] =
  Object.freeze([
    Object.freeze({
      metadata: TEXT_BLOCK_RELEASE,
      render: PlainTextDisplay,
      parsePayload: TEXT_PAYLOAD_PARSER,
    }),
    Object.freeze({
      metadata: RICH_TEXT_BLOCK_RELEASE,
      render: RichTextDisplay,
      parsePayload: RICH_TEXT_PAYLOAD_PARSER,
    }),
    Object.freeze({
      metadata: LIST_BLOCK_RELEASE,
      render: ListDisplay,
      parsePayload: LIST_PAYLOAD_PARSER,
    }),
    Object.freeze({
      metadata: TABLE_BLOCK_RELEASE,
      render: TableDisplay,
      parsePayload: TABLE_PAYLOAD_PARSER,
    }),
    Object.freeze({
      metadata: RECORD_DETAIL_BLOCK_RELEASE,
      render: RecordDetailDisplay,
      parsePayload: RECORD_DETAIL_PAYLOAD_PARSER,
    }),
    Object.freeze({
      metadata: GROUPED_DATA_BLOCK_RELEASE,
      render: GroupedDataDisplay,
      parsePayload: GROUPED_DATA_PAYLOAD_PARSER,
    }),
    Object.freeze({
      metadata: SUMMARY_VALUES_BLOCK_RELEASE,
      render: SummaryValuesDisplay,
      parsePayload: SUMMARY_VALUES_PAYLOAD_PARSER,
    }),
    // Release 1.1.0 adds the optional authored empty message; the same parser serves both releases.
    Object.freeze({
      metadata: TEXT_BLOCK_RELEASE_1_1_0,
      render: PlainTextDisplay,
      parsePayload: TEXT_PAYLOAD_PARSER,
    }),
    Object.freeze({
      metadata: RICH_TEXT_BLOCK_RELEASE_1_1_0,
      render: RichTextDisplay,
      parsePayload: RICH_TEXT_PAYLOAD_PARSER,
    }),
    Object.freeze({
      metadata: LIST_BLOCK_RELEASE_1_1_0,
      render: ListDisplay,
      parsePayload: LIST_PAYLOAD_PARSER,
    }),
    Object.freeze({
      metadata: TABLE_BLOCK_RELEASE_1_1_0,
      render: TableDisplay,
      parsePayload: TABLE_PAYLOAD_PARSER,
    }),
    Object.freeze({
      metadata: RECORD_DETAIL_BLOCK_RELEASE_1_1_0,
      render: RecordDetailDisplay,
      parsePayload: RECORD_DETAIL_PAYLOAD_PARSER,
    }),
    Object.freeze({
      metadata: GROUPED_DATA_BLOCK_RELEASE_1_1_0,
      render: GroupedDataDisplay,
      parsePayload: GROUPED_DATA_PAYLOAD_PARSER,
    }),
    Object.freeze({
      metadata: SUMMARY_VALUES_BLOCK_RELEASE_1_1_0,
      render: SummaryValuesDisplay,
      parsePayload: SUMMARY_VALUES_PAYLOAD_PARSER,
    }),
    // Release 1.2.0 declares the data contract as settings; the same renderers and parsers read it.
    Object.freeze({
      metadata: TABLE_BLOCK_RELEASE_1_2_0,
      render: TableDisplay,
      parsePayload: TABLE_PAYLOAD_PARSER,
    }),
    Object.freeze({
      metadata: RECORD_DETAIL_BLOCK_RELEASE_1_2_0,
      render: RecordDetailDisplay,
      parsePayload: RECORD_DETAIL_PAYLOAD_PARSER,
    }),
    // Release 1.3.0 adds configured row behaviours to the Records table; the same parser reads them.
    Object.freeze({
      metadata: TABLE_BLOCK_RELEASE_1_3_0,
      render: TableDisplay,
      parsePayload: TABLE_PAYLOAD_PARSER,
    }),
  ]);

/** Creates an immutable PlatformComponentRegistry populated with every display block release. */
export function createDisplayComponentRegistry(): PlatformComponentRegistry {
  return createPlatformComponentRegistry(DISPLAY_COMPONENT_REGISTRATIONS);
}
