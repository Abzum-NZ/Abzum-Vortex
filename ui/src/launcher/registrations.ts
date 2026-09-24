import {
  APPLICATION_LAUNCHER_BLOCK_RELEASE,
  LINK_TILES_BLOCK_RELEASE,
  VIEW_FILTER_BLOCK_RELEASE,
} from "@vortex/contracts";
import {
  createPlatformComponentRegistry,
  type PlatformComponentRegistration,
  type PlatformComponentRegistry,
} from "../registry";
import { ApplicationLauncher } from "./application-launcher";
import { LinkTiles } from "./link-tiles";
import { ViewFilter } from "./view-filter";

/**
 * Release metadata is owned by the server-side platform block catalogue in @vortex/contracts;
 * these registrations only pair each registered release with its renderer, so a renderer change
 * cannot redefine or extend what authors may place.
 */
export {
  APPLICATION_LAUNCHER_BLOCK_RELEASE,
  LINK_TILES_BLOCK_RELEASE,
  VIEW_FILTER_BLOCK_RELEASE,
};

/** Exact registrations pairing each launcher block release with its React renderer. */
export const LAUNCHER_COMPONENT_REGISTRATIONS: readonly PlatformComponentRegistration[] =
  Object.freeze([
    Object.freeze({ metadata: APPLICATION_LAUNCHER_BLOCK_RELEASE, render: ApplicationLauncher }),
    Object.freeze({ metadata: LINK_TILES_BLOCK_RELEASE, render: LinkTiles }),
    Object.freeze({ metadata: VIEW_FILTER_BLOCK_RELEASE, render: ViewFilter }),
  ]);

/** Creates an immutable PlatformComponentRegistry populated with all launcher components. */
export function createLauncherComponentRegistry(): PlatformComponentRegistry {
  return createPlatformComponentRegistry(LAUNCHER_COMPONENT_REGISTRATIONS);
}
