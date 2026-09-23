import {
  createPlatformComponentRegistry,
  type PlatformComponentRegistration,
  type PlatformComponentRegistry,
} from "./registry";
import { DISPLAY_COMPONENT_REGISTRATIONS } from "./display/registrations";
import { CONTROL_COMPONENT_REGISTRATIONS } from "./controls/registrations";

/** All eighteen platform component registrations combining display and control families. */
export const ALL_PLATFORM_COMPONENT_REGISTRATIONS: readonly PlatformComponentRegistration[] =
  Object.freeze([
    ...DISPLAY_COMPONENT_REGISTRATIONS,
    ...CONTROL_COMPONENT_REGISTRATIONS,
  ]);

/** Creates an immutable PlatformComponentRegistry populated with all 18 display and control components. */
export function createFullPlatformComponentRegistry(): PlatformComponentRegistry {
  return createPlatformComponentRegistry(ALL_PLATFORM_COMPONENT_REGISTRATIONS);
}
