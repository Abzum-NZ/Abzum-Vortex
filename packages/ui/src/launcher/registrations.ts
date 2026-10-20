import {
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
  projectedLinkTilesSchema,
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
  parseLauncherRowsPayload,
} from "../display/projected-data";

/**
 * The application launcher is a read-only display surface over the `launcher_rows` payload. The
 * view filter binds nothing: it only narrows rows its content slot already received, so its parser
 * refuses every supplied input.
 */
const LAUNCHER_ROWS_PAYLOAD_PARSER: PlatformComponentPayloadParser = createPayloadParser({
  data: (value, location: DefinitionRenderErrorLocation) =>
    parseDisplayData(value, parseLauncherRowsPayload, location),
  events: (value, location) => parseDisplayEventHandlers(value, location),
});

// Link tiles consume the typed target payload and the current-visible invocation port.
const LINK_TILES_PAYLOAD_INPUTS = createPayloadParser({
  data: (value, location) =>
    parseDisplayData(
      value,
      (values) => {
        const parsed = projectedLinkTilesSchema.safeParse(values);
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
const LINK_TILES_PAYLOAD_PARSER: PlatformComponentPayloadParser = (value, location) => {
  const parsed = LINK_TILES_PAYLOAD_INPUTS(value, location);
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
      parsePayload: LAUNCHER_ROWS_PAYLOAD_PARSER,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.LINK_TILES_BLOCK_RELEASE,
      parsePayload: LINK_TILES_PAYLOAD_PARSER,
    }),
  ]);
