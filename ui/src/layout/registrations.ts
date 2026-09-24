import {
  CONTAINER_BLOCK_RELEASE,
  HEADING_BLOCK_RELEASE,
  LAYOUT_BLOCK_RELEASES,
} from "@vortex/contracts";
import {
  createPlatformComponentRegistry,
  type PlatformComponentRegistration,
  type PlatformComponentRegistry,
} from "../registry";
import { Container } from "./container";
import { Heading } from "./heading";

/**
 * Release metadata is owned by the server-side platform block catalogue in @vortex/contracts;
 * these registrations only pair each registered release with its renderer, so a renderer change
 * cannot redefine or extend what authors may place.
 */
export { CONTAINER_BLOCK_RELEASE, HEADING_BLOCK_RELEASE, LAYOUT_BLOCK_RELEASES };

/** Exact registrations pairing each general layout block release with its React renderer. */
export const LAYOUT_COMPONENT_REGISTRATIONS: readonly PlatformComponentRegistration[] =
  Object.freeze([
    Object.freeze({ metadata: CONTAINER_BLOCK_RELEASE, render: Container }),
    Object.freeze({ metadata: HEADING_BLOCK_RELEASE, render: Heading }),
  ]);

/** Creates an immutable PlatformComponentRegistry populated with all general layout components. */
export function createLayoutComponentRegistry(): PlatformComponentRegistry {
  return createPlatformComponentRegistry(LAYOUT_COMPONENT_REGISTRATIONS);
}
