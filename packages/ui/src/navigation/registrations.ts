import {
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
} from "@vortex/platform/schema";
import {
  noRuntimeInputs,
  type PlatformComponentRegistration,
} from "../registry";

/**
 * Navigation, account, and search blocks read platform context from the signed-in page. None
 * accepts authored runtime inputs or invents application data.
 */
export const NAVIGATION_COMPONENT_REGISTRATIONS: readonly PlatformComponentRegistration[] =
  Object.freeze([
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.APPLICATION_NAVIGATION_BLOCK_RELEASE,
      parsePayload: noRuntimeInputs,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.APPLICATION_ACCOUNT_ACTIONS_BLOCK_RELEASE,
      parsePayload: noRuntimeInputs,
    }),
    Object.freeze({
      releaseIdentity: PLATFORM_BLOCK_RELEASE_IDENTITIES.APPLICATION_SEARCH_BLOCK_RELEASE,
      parsePayload: noRuntimeInputs,
    }),
  ]);
