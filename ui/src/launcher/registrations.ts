import {
  APPLICATION_LAUNCHER_BLOCK_RELEASE,
  LINK_TILES_BLOCK_RELEASE,
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
      metadata: VIEW_FILTER_BLOCK_RELEASE,
      render: ViewFilter,
      parsePayload: noRuntimeInputs,
    }),
  ]);

/** Creates an immutable PlatformComponentRegistry populated with all launcher components. */
export function createLauncherComponentRegistry(): PlatformComponentRegistry {
  return createPlatformComponentRegistry(LAUNCHER_COMPONENT_REGISTRATIONS);
}
