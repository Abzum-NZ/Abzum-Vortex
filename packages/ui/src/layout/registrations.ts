import {
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
  type PlatformBlockRelease,
} from "@vortex/platform/schema";
import {
  createPlatformComponentRegistry,
  noRuntimeInputs,
  type PlatformComponentRegistration,
  type PlatformComponentRegistry,
} from "../registry";

/**
 * Exact registrations pairing each general layout block release with its React renderer. A layout
 * block carries no data and emits no event, so its parser refuses every supplied runtime input.
 */
export const LAYOUT_COMPONENT_REGISTRATIONS: readonly PlatformComponentRegistration[] =
  Object.freeze([
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.CONTAINER_BLOCK_RELEASE,
      parsePayload: noRuntimeInputs,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.CONTAINER_BLOCK_RELEASE_1_1_0,
      parsePayload: noRuntimeInputs,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.CONTAINER_BLOCK_RELEASE_1_2_0,
      parsePayload: noRuntimeInputs,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.CONTAINER_BLOCK_RELEASE_1_3_0,
      parsePayload: noRuntimeInputs,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.HEADING_BLOCK_RELEASE,
      parsePayload: noRuntimeInputs,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.HEADING_BLOCK_RELEASE_1_1_0,
      parsePayload: noRuntimeInputs,
    }),
  ]);

/** Creates an immutable PlatformComponentRegistry populated with all general layout components. */
export function createLayoutComponentRegistry(
  platformReleases: readonly PlatformBlockRelease[],
): PlatformComponentRegistry {
  return createPlatformComponentRegistry(LAYOUT_COMPONENT_REGISTRATIONS, platformReleases);
}
