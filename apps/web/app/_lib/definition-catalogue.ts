import "server-only";

import {
  DEFAULT_PLATFORM_THEME_RELEASE,
  IMMUTABLE_PLATFORM_BLOCK_CATALOGUE,
  PLATFORM_CONNECTION_TYPE_RELEASES,
  PLATFORM_BLOCK_RELEASES,
} from "@vortex/platform/server";
import {
  containsCustomComponentReleases,
  type PlatformBlockRelease,
  type SystemApplicationBoundReleaseSetResult,
} from "@vortex/platform/schema";
import type { ImmutableDefinitionPublicationCatalogueDefinition } from "@vortex/platform/server";
import { platformPermissionSource } from "./platform-permission-source";

/**
 * The publication catalogue every installed release was published against: every registered
 * platform block release, connection type release and the default platform theme (platform service
 * operation releases are always part of the catalogue). Reading an installed release verifies each
 * platform dependency in its manifest against this catalogue, so a catalogue that lacks them makes
 * every installed application refuse as "dependency unavailable". No custom component release is a
 * platform catalogue entry.
 */
export const installedReleaseCatalogue: ImmutableDefinitionPublicationCatalogueDefinition = {
  permissions: platformPermissionSource,
  connectionTypeReleases: PLATFORM_CONNECTION_TYPE_RELEASES,
  applicationComposition: {
    compositionPolicy: IMMUTABLE_PLATFORM_BLOCK_CATALOGUE.compositionPolicy,
    platformBlockReleases: PLATFORM_BLOCK_RELEASES.map(
      ({ contentFingerprint, customComponent, ...definition }) => definition,
    ),
    platformThemeReleases: [
      (({ contentFingerprint, ...definition }) => definition)(DEFAULT_PLATFORM_THEME_RELEASE),
    ],
  },
};

/**
 * Whether an exact release set places any custom component, derived from the application's own
 * block dependency manifest rather than assumed. Each dependency is matched to the exact registered
 * block release it names; a release that carries a custom component counts, and so does any
 * dependency that is not exactly a registered release, so an unknown block can never skip the
 * `custom_code.manage` and recent sign-in requirements installation adds for custom code.
 */
export const releaseSetContainsCustomComponents = (
  releaseSet: SystemApplicationBoundReleaseSetResult,
): boolean => {
  const releases: PlatformBlockRelease[] = [];
  for (const dependency of releaseSet.application.content.platformBlockDependencies) {
    const release = PLATFORM_BLOCK_RELEASES.find(
      (candidate) =>
        candidate.blockId === dependency.blockId &&
        candidate.releaseVersion === dependency.releaseVersion &&
        candidate.contentFingerprint === dependency.contentFingerprint,
    );
    if (release === undefined) return true;
    releases.push(release);
  }
  return containsCustomComponentReleases(releases);
};
