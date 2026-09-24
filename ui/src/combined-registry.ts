import {
  createPlatformComponentRegistry,
  type PlatformComponentRegistration,
  type PlatformComponentRegistry,
} from "./registry";
import { DISPLAY_COMPONENT_REGISTRATIONS } from "./display/registrations";
import { CONTROL_COMPONENT_REGISTRATIONS } from "./controls/registrations";
import { LAUNCHER_COMPONENT_REGISTRATIONS } from "./launcher/registrations";
import { LAYOUT_COMPONENT_REGISTRATIONS } from "./layout/registrations";

/** All twenty-five platform component registrations combining display, control, launcher and layout families. */
export const ALL_PLATFORM_COMPONENT_REGISTRATIONS: readonly PlatformComponentRegistration[] =
  Object.freeze([
    ...DISPLAY_COMPONENT_REGISTRATIONS,
    ...CONTROL_COMPONENT_REGISTRATIONS,
    ...LAUNCHER_COMPONENT_REGISTRATIONS,
    ...LAYOUT_COMPONENT_REGISTRATIONS,
  ]);

/** Creates an immutable PlatformComponentRegistry populated with all 25 display, control, launcher and layout components. */
export function createFullPlatformComponentRegistry(): PlatformComponentRegistry {
  return createPlatformComponentRegistry(ALL_PLATFORM_COMPONENT_REGISTRATIONS);
}
