import {
  APPLICATION_ACCOUNT_ACTIONS_BLOCK_RELEASE,
  APPLICATION_NAVIGATION_BLOCK_RELEASE,
  APPLICATION_SEARCH_BLOCK_RELEASE,
  NAVIGATION_BLOCK_RELEASES,
} from "@vortex/contracts";
import {
  createPlatformComponentRegistry,
  noRuntimeInputs,
  type PlatformComponentRegistration,
  type PlatformComponentRegistry,
} from "../registry";

/**
 * Release metadata is owned by the server-side platform block catalogue in @vortex/contracts;
 * these registrations only pair each registered release with its renderer, so a renderer change
 * cannot redefine or extend what authors may place.
 */
export {
  APPLICATION_ACCOUNT_ACTIONS_BLOCK_RELEASE,
  APPLICATION_NAVIGATION_BLOCK_RELEASE,
  NAVIGATION_BLOCK_RELEASES,
};

/**
 * Navigation, account, and search blocks read platform context from the signed-in page. None
 * accepts authored runtime inputs or invents application data.
 */
export const NAVIGATION_COMPONENT_REGISTRATIONS: readonly PlatformComponentRegistration[] =
  Object.freeze([
    Object.freeze({
      metadata: APPLICATION_NAVIGATION_BLOCK_RELEASE,
      parsePayload: noRuntimeInputs,
    }),
    Object.freeze({
      metadata: APPLICATION_ACCOUNT_ACTIONS_BLOCK_RELEASE,
      parsePayload: noRuntimeInputs,
    }),
    Object.freeze({
      metadata: APPLICATION_SEARCH_BLOCK_RELEASE,
      parsePayload: noRuntimeInputs,
    }),
  ]);

/** Creates an immutable registry for application navigation, account actions, and search. */
export function createNavigationComponentRegistry(): PlatformComponentRegistry {
  return createPlatformComponentRegistry(NAVIGATION_COMPONENT_REGISTRATIONS);
}
