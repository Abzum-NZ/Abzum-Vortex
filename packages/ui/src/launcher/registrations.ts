import {
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
  projectedApplicationPageLinkTilesSchema,
  projectedRecordPinTilesSchema,
  mountedRecordPinFrameSchema,
} from "@vortex/platform/schema";
import {
  createPayloadParser,
  type PlatformComponentPayloadParser,
  type PlatformComponentRegistration,
} from "../registry";
import type { DefinitionRenderErrorLocation } from "../definition-error";
import { DefinitionRenderError } from "../definition-error";
import {
  parseDisplayData,
  parseDisplayEventHandlers,
  parseListPayload,
} from "../display/projected-data";

/**
 * The launcher and tile blocks are read-only display surfaces over the one `list` payload they
 * declare, so each supplies that one parser. The view filter binds nothing: it only narrows rows
 * its content slot already received, so its parser refuses every supplied input.
 */
const LIST_PAYLOAD_PARSER: PlatformComponentPayloadParser = createPayloadParser({
  data: (value, location: DefinitionRenderErrorLocation) =>
    parseDisplayData(value, parseListPayload, location),
  events: (value, location) => parseDisplayEventHandlers(value, location),
});

const RECORD_PIN_PAYLOAD_INPUTS = createPayloadParser({
  data: (value, location) =>
    parseDisplayData(
      value,
      (values) => {
        const parsed = projectedRecordPinTilesSchema.safeParse(values);
        if (!parsed.success)
          throw new DefinitionRenderError(
            "INVALID_COMPOSITION",
            "Invalid protected tile projection",
            location,
          );
        return parsed.data;
      },
      location,
    ),
  events: (value, location) => parseDisplayEventHandlers(value, location),
  open_tile: (value, location) => {
    if (typeof value !== "function")
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        "A tile activation must be a callback",
        location,
      );
    return async (sourceRecordId: string, sourceRevision: number): Promise<void> => {
      await value(sourceRecordId, sourceRevision);
    };
  },
  pin_frame: (value, location) => {
    const parsed = mountedRecordPinFrameSchema.safeParse(value);
    if (!parsed.success)
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        "Invalid tile invocation frame",
        location,
      );
    return parsed.data;
  },
});

// Component-specific inputs keep the original list renderer's data type and parser intact.
const RECORD_PIN_PAYLOAD_PARSER: PlatformComponentPayloadParser = (value, location) => {
  const parsed = RECORD_PIN_PAYLOAD_INPUTS(value, location);
  return Object.freeze({
    pinData: parsed.data,
    events: parsed.events,
    openTile: parsed.open_tile,
    pinFrame: parsed.pin_frame,
  });
};

// Only the newly declared release consumes the mixed payload and current-visible invocation port.
const APPLICATION_PAGE_LINK_PAYLOAD_INPUTS = createPayloadParser({
  data: (value, location) =>
    parseDisplayData(
      value,
      (values) => {
        const parsed = projectedApplicationPageLinkTilesSchema.safeParse(values);
        if (!parsed.success)
          throw new DefinitionRenderError(
            "INVALID_COMPOSITION",
            "Invalid protected tile projection",
            location,
          );
        return parsed.data;
      },
      location,
    ),
  events: (value, location) => parseDisplayEventHandlers(value, location),
  open_tile: (value, location) => {
    if (typeof value !== "function")
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        "A tile activation must be a callback",
        location,
      );
    return async (
      sourceRecordId: string,
      sourceRevision: number,
      isVisible?: () => boolean,
    ): Promise<void> => {
      if (typeof isVisible !== "function" || !isVisible()) return;
      await value(sourceRecordId, sourceRevision, isVisible);
    };
  },
  pin_frame: (value, location) => {
    const parsed = mountedRecordPinFrameSchema.safeParse(value);
    if (!parsed.success)
      throw new DefinitionRenderError(
        "INVALID_COMPOSITION",
        "Invalid tile invocation frame",
        location,
      );
    return parsed.data;
  },
});
const APPLICATION_PAGE_LINK_PAYLOAD_PARSER: PlatformComponentPayloadParser = (value, location) => {
  const parsed = APPLICATION_PAGE_LINK_PAYLOAD_INPUTS(value, location);
  return Object.freeze({
    pinData: parsed.data,
    events: parsed.events,
    openTile: parsed.open_tile,
    pinFrame: parsed.pin_frame,
  });
};

/** Exact registrations pairing each launcher block release with its React renderer. */
export const LAUNCHER_COMPONENT_REGISTRATIONS: readonly PlatformComponentRegistration[] =
  Object.freeze([
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.APPLICATION_LAUNCHER_BLOCK_RELEASE,
      parsePayload: LIST_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.LINK_TILES_BLOCK_RELEASE,
      parsePayload: LIST_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.RECORD_PIN_LINK_TILES_BLOCK_RELEASE,
      parsePayload: RECORD_PIN_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.APPLICATION_PAGE_LINK_TILES_BLOCK_RELEASE,
      parsePayload: APPLICATION_PAGE_LINK_PAYLOAD_PARSER,
    }),
  ]);
