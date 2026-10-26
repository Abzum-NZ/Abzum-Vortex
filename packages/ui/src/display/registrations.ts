import { PLATFORM_BLOCK_RELEASE_IDENTITIES } from "@vortex/platform/schema";
import {
  createPayloadParser,
  noRuntimeInputs,
  type PlatformComponentPayloadParser,
  type PlatformComponentRegistration,
} from "../registry";
import type { DefinitionRenderErrorLocation } from "../definition-error";
import { checkCalendarPayload } from "./calendar-payload";
import { parseDisplayEventHandlers, readDisplayData, type CalendarPayload } from "./projected-data";
import { QUERY_NOTICE_PAYLOAD_PARSER } from "./query-notice";

/**
 * The parser a display block's registration supplies: its projected state under `data` and its own
 * declared semantic callbacks under `events`. The ready values are the payload the server built for
 * that block; a block whose values need a check only the browser can make names it.
 */
const displayPayloadParser = (
  readValues?: (values: unknown, location: DefinitionRenderErrorLocation) => unknown,
): PlatformComponentPayloadParser =>
  createPayloadParser({
    data: (value, location) => readDisplayData(value, location, readValues),
    events: (value, location) => parseDisplayEventHandlers(value, location),
  });

const DISPLAY_PAYLOAD_PARSER = displayPayloadParser();
const CALENDAR_PAYLOAD_PARSER = displayPayloadParser((values, location) =>
  checkCalendarPayload(values as CalendarPayload, location),
);

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
      parsePayload: DISPLAY_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.RICH_TEXT_BLOCK_RELEASE,
      parsePayload: DISPLAY_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.RECORD_DETAIL_BLOCK_RELEASE,
      parsePayload: DISPLAY_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.SUMMARY_VALUES_BLOCK_RELEASE,
      parsePayload: DISPLAY_PAYLOAD_PARSER,
    }),
    // The one Data grid release: its data contract, row behaviours, interactive controls and Board mode.
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.TABLE_BLOCK_RELEASE,
      parsePayload: DISPLAY_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.CALENDAR_BLOCK_RELEASE,
      parsePayload: CALENDAR_PAYLOAD_PARSER,
    }),
  ]);
