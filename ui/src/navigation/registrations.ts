import {
  APPLICATION_NAVIGATION_BLOCK_RELEASE,
  NAVIGATION_BLOCK_RELEASES,
} from "@vortex/contracts";
import {
  createPlatformComponentRegistry,
  type PlatformComponentRegistration,
  type PlatformComponentRegistry,
} from "../registry";
import { ApplicationNavigationBlock } from "./navigation";

/**
 * Release metadata is owned by the server-side platform block catalogue in @vortex/contracts;
 * these registrations only pair each registered release with its renderer, so a renderer change
 * cannot redefine or extend what authors may place.
 */
export { APPLICATION_NAVIGATION_BLOCK_RELEASE, NAVIGATION_BLOCK_RELEASES };

/** Exact registration pairing the application navigation block release with its React renderer. */
export const NAVIGATION_COMPONENT_REGISTRATIONS: readonly PlatformComponentRegistration[] =
  Object.freeze([
    Object.freeze({
      metadata: APPLICATION_NAVIGATION_BLOCK_RELEASE,
      render: ApplicationNavigationBlock,
    }),
  ]);

/** Creates an immutable PlatformComponentRegistry populated with the application navigation block. */
export function createNavigationComponentRegistry(): PlatformComponentRegistry {
  return createPlatformComponentRegistry(NAVIGATION_COMPONENT_REGISTRATIONS);
}
