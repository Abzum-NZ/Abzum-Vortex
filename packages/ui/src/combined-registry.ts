import {
  createPlatformComponentRegistry,
  type PlatformComponentRegistration,
  type PlatformComponentRegistry,
} from "./registry";
import type { PlatformBlockRelease } from "@vortex/platform/schema";
import { DISPLAY_COMPONENT_REGISTRATIONS } from "./display/registrations";
import { CHART_COMPONENT_REGISTRATIONS } from "./display/chart";
import { ATTACHMENT_COMPONENT_REGISTRATIONS } from "./search-attachment-blocks";
import { CONTROL_COMPONENT_REGISTRATIONS } from "./controls/registrations";
import { LAUNCHER_COMPONENT_REGISTRATIONS } from "./launcher/registrations";
import { LAYOUT_COMPONENT_REGISTRATIONS } from "./layout/registrations";
import { NAVIGATION_COMPONENT_REGISTRATIONS } from "./navigation/registrations";

/** Every platform component registration, combining the display, control, launcher, layout and navigation families. */
export const ALL_PLATFORM_COMPONENT_REGISTRATIONS: readonly PlatformComponentRegistration[] =
  Object.freeze([
    ...DISPLAY_COMPONENT_REGISTRATIONS,
    ...ATTACHMENT_COMPONENT_REGISTRATIONS,
    ...CHART_COMPONENT_REGISTRATIONS,
    ...CONTROL_COMPONENT_REGISTRATIONS,
    ...LAUNCHER_COMPONENT_REGISTRATIONS,
    ...LAYOUT_COMPONENT_REGISTRATIONS,
    ...NAVIGATION_COMPONENT_REGISTRATIONS,
  ]);

/** Creates an immutable PlatformComponentRegistry populated with every display, control, launcher, layout and navigation release. */
export function createFullPlatformComponentRegistry(
  platformReleases: readonly PlatformBlockRelease[],
): PlatformComponentRegistry {
  return createPlatformComponentRegistry(ALL_PLATFORM_COMPONENT_REGISTRATIONS, platformReleases);
}

/** Creates an immutable registry containing only registrations for the supplied release metadata. */
export function createPlatformComponentRegistryForReleases(
  platformReleases: readonly PlatformBlockRelease[],
): PlatformComponentRegistry {
  const releaseIdentities = new Set(
    platformReleases.map((release) => `${release.key}:${release.releaseVersion}`),
  );
  const registrations = ALL_PLATFORM_COMPONENT_REGISTRATIONS.filter((registration) => {
    const identity = registration.metadata ?? registration.releaseIdentity;
    return (
      identity !== undefined && releaseIdentities.has(`${identity.key}:${identity.releaseVersion}`)
    );
  });
  return createPlatformComponentRegistry(registrations, platformReleases);
}
