import { semanticVersionSchema } from "./identifiers";
import type { SemanticVersion } from "./identifiers";

/** Semantic version schema for the Application package/platform compatibility protocol. */
export const applicationPlatformCompatibilityVersionSchema = semanticVersionSchema;

// Advance this trusted protocol version deliberately when Application package/runtime
// compatibility changes. It is independent of the repository package and permission catalogue.
const currentApplicationPlatformCompatibilityVersion = "1.0.0" as const;
applicationPlatformCompatibilityVersionSchema.parse(
  currentApplicationPlatformCompatibilityVersion,
);

export const APPLICATION_PLATFORM_COMPATIBILITY_VERSION =
  currentApplicationPlatformCompatibilityVersion;

export type ApplicationPlatformCompatibilityVersion = SemanticVersion;
