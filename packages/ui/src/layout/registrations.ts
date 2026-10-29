import { PLATFORM_BLOCK_RELEASE_IDENTITIES } from "@vortex/platform/schema";
import { noRuntimeInputs, type PlatformComponentRegistration } from "../registry";

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
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.HEADING_BLOCK_RELEASE,
      parsePayload: noRuntimeInputs,
    }),
  ]);
