import {
  createPlatformComponentRegistry,
  type PlatformComponentRegistration,
  type PlatformComponentRegistry,
} from "./registry";
import { DISPLAY_COMPONENT_REGISTRATIONS } from "./display/registrations";
import { CONTROL_COMPONENT_REGISTRATIONS } from "./controls/registrations";
import { LAUNCHER_COMPONENT_REGISTRATIONS } from "./launcher/registrations";

/** All twenty-three platform component registrations combining display, control and launcher families. */
export const ALL_PLATFORM_COMPONENT_REGISTRATIONS: readonly PlatformComponentRegistration[] =
  Object.freeze([
    ...DISPLAY_COMPONENT_REGISTRATIONS,
    ...CONTROL_COMPONENT_REGISTRATIONS,
    ...LAUNCHER_COMPONENT_REGISTRATIONS,
  ]);

/** Creates an immutable PlatformComponentRegistry populated with all 23 display, control and launcher components. */
export function createFullPlatformComponentRegistry(): PlatformComponentRegistry {
  return createPlatformComponentRegistry(ALL_PLATFORM_COMPONENT_REGISTRATIONS);
}
