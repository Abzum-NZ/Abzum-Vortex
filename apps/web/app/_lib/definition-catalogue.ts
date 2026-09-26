import "server-only";

import {
  DEFAULT_PLATFORM_THEME_RELEASE_V2,
  IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2,
  PLATFORM_BLOCK_RELEASES,
} from "@vortex/contracts";
import type { ImmutableDefinitionPublicationCatalogueDefinition } from "@vortex/definition";

/**
 * The publication catalogue every installed release was published against: every registered
 * platform block release and the default platform theme (platform service operation releases are
 * always part of the catalogue). Reading an installed release verifies each platform dependency
 * in its manifest against this catalogue, so a catalogue that lacks them makes every installed
 * application refuse as "dependency unavailable". No customer-owned connection type or custom
 * component release is a platform catalogue entry; the platform ships no connection types yet.
 */
export const installedReleaseCatalogue: ImmutableDefinitionPublicationCatalogueDefinition = {
  connectionTypeReleases: [],
  applicationCompositionV2: {
    compositionPolicy: IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2.compositionPolicy,
    platformBlockReleases: PLATFORM_BLOCK_RELEASES.map(
      ({ contentFingerprint, catalogueFingerprint, customComponent, ...definition }) => definition,
    ),
    platformThemeReleases: [
      (({ contentFingerprint, catalogueFingerprint, ...definition }) => definition)(
        DEFAULT_PLATFORM_THEME_RELEASE_V2,
      ),
    ],
  },
};
