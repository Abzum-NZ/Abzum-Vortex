import {
  APPLICATION_LAUNCHER_BLOCK_RELEASE,
  LINK_TILES_BLOCK_RELEASE,
  RECORD_PIN_LINK_TILES_BLOCK_RELEASE,
  APPLICATION_PAGE_LINK_TILES_BLOCK_RELEASE,
  projectedApplicationPageLinkTilesSchema,
  projectedRecordPinTilesSchema,
  mountedRecordPinFrameSchema,
  VIEW_FILTER_BLOCK_RELEASE,
} from "@vortex/contracts";
import {
  createPayloadParser,
  createPlatformComponentRegistry,
  noRuntimeInputs,
  type PlatformComponentPayloadParser,
  type PlatformComponentRegistration,
  type PlatformComponentRegistry,
} from "../registry";
import type { DefinitionRenderErrorLocation } from "../definition-error";
import { DefinitionRenderError } from "../definition-error";
import {
  parseDisplayData,
  parseDisplayEventHandlers,
  parseListPayload,
} from "../display/projected-data";
import { ApplicationLauncher } from "./application-launcher";
import { LinkTiles } from "./link-tiles";
import { ViewFilter } from "./view-filter";

/**
 * Release metadata is owned by the server-side platform block catalogue in @vortex/contracts;
 * these registrations only pair each registered release with its renderer, so a renderer
 * change cannot redefine or extend what authors may place.
 */
export {
  APPLICATION_LAUNCHER_BLOCK_RELEASE,
  LINK_TILES_BLOCK_RELEASE,
  VIEW_FILTER_BLOCK_RELEASE,
};

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
  data: (value, location) => parseDisplayData(value, (values) => {
    const parsed = projectedRecordPinTilesSchema.safeParse(values);
    if (!parsed.success) throw new DefinitionRenderError("INVALID_COMPOSITION", "Invalid protected tile projection", location);
    return parsed.data;
  }, location),
  events: (value, location) => parseDisplayEventHandlers(value, location),
  open_tile: (value, location) => {
    if (typeof value !== "function") throw new DefinitionRenderError("INVALID_COMPOSITION", "A tile activation must be a callback", location);
    return async (sourceRecordId: string, sourceRevision: number): Promise<void> => {
      await value(sourceRecordId, sourceRevision);
    };
  },
  pin_frame: (value, location) => {
    const parsed = mountedRecordPinFrameSchema.safeParse(value);
    if (!parsed.success) throw new DefinitionRenderError("INVALID_COMPOSITION", "Invalid tile invocation frame", location);
    return parsed.data;
  },
});

// Component-specific inputs keep the original list renderer's data type and parser intact.
const RECORD_PIN_PAYLOAD_PARSER: PlatformComponentPayloadParser = (value, location) => {
  const parsed = RECORD_PIN_PAYLOAD_INPUTS(value, location);
  return Object.freeze({ pinData: parsed.data, events: parsed.events, openTile: parsed.open_tile, pinFrame: parsed.pin_frame });
};

// Only the newly declared release consumes the mixed payload and current-visible invocation port.
const APPLICATION_PAGE_LINK_PAYLOAD_INPUTS = createPayloadParser({
  data: (value, location) => parseDisplayData(value, (values) => {
    const parsed = projectedApplicationPageLinkTilesSchema.safeParse(values);
    if (!parsed.success) throw new DefinitionRenderError("INVALID_COMPOSITION", "Invalid protected tile projection", location);
    return parsed.data;
  }, location),
  events: (value, location) => parseDisplayEventHandlers(value, location),
  open_tile: (value, location) => {
    if (typeof value !== "function") throw new DefinitionRenderError("INVALID_COMPOSITION", "A tile activation must be a callback", location);
    return async (sourceRecordId: string, sourceRevision: number, isVisible?: () => boolean): Promise<void> => {
      if (typeof isVisible !== "function" || !isVisible()) return;
      await value(sourceRecordId, sourceRevision, isVisible);
    };
  },
  pin_frame: (value, location) => {
    const parsed = mountedRecordPinFrameSchema.safeParse(value);
    if (!parsed.success) throw new DefinitionRenderError("INVALID_COMPOSITION", "Invalid tile invocation frame", location);
    return parsed.data;
  },
});
const APPLICATION_PAGE_LINK_PAYLOAD_PARSER: PlatformComponentPayloadParser = (value, location) => {
  const parsed = APPLICATION_PAGE_LINK_PAYLOAD_INPUTS(value, location);
  return Object.freeze({ pinData: parsed.data, events: parsed.events, openTile: parsed.open_tile, pinFrame: parsed.pin_frame });
};

/** Exact registrations pairing each launcher block release with its React renderer. */
export const LAUNCHER_COMPONENT_REGISTRATIONS: readonly PlatformComponentRegistration[] =
  Object.freeze([
    Object.freeze({
      metadata: APPLICATION_LAUNCHER_BLOCK_RELEASE,
      render: ApplicationLauncher,
      parsePayload: LIST_PAYLOAD_PARSER,
    }),
    Object.freeze({
      metadata: LINK_TILES_BLOCK_RELEASE,
      render: LinkTiles,
      parsePayload: LIST_PAYLOAD_PARSER,
    }),
    Object.freeze({
      metadata: RECORD_PIN_LINK_TILES_BLOCK_RELEASE,
      render: LinkTiles,
      parsePayload: RECORD_PIN_PAYLOAD_PARSER,
    }),
    Object.freeze({
      metadata: APPLICATION_PAGE_LINK_TILES_BLOCK_RELEASE,
      render: LinkTiles,
      parsePayload: APPLICATION_PAGE_LINK_PAYLOAD_PARSER,
    }),
    Object.freeze({
      metadata: VIEW_FILTER_BLOCK_RELEASE,
      render: ViewFilter,
      parsePayload: noRuntimeInputs,
    }),
  ]);

/** Creates an immutable PlatformComponentRegistry populated with all launcher components. */
export function createLauncherComponentRegistry(): PlatformComponentRegistry {
  return createPlatformComponentRegistry(LAUNCHER_COMPONENT_REGISTRATIONS);
}
