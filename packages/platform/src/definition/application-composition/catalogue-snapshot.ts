import { z } from "zod";
import { sourceProvenanceUnchanged } from "../definition-source-common";
import { fingerprintSchema } from "../../catalogue/identifiers";
import { immutablePlatformBlockCatalogueSchema } from "./platform-block-release";
import { deterministicDependencyList } from "./shared";
import { platformThemeReleaseSchema } from "./theme";

/**
 * Exact catalogue evidence locked by a trusted caller before pure  compilation.
 * Its fingerprint covers every field except the fingerprint itself.
 */
export const applicationCompositionCatalogueSnapshotSchema = z
  .object({
    contractVersion: sourceProvenanceUnchanged(z.literal("2.0.0")),
    fingerprint: sourceProvenanceUnchanged(fingerprintSchema),
    platformBlocks: sourceProvenanceUnchanged(immutablePlatformBlockCatalogueSchema),
    platformTheme: sourceProvenanceUnchanged(platformThemeReleaseSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const blockIdentities = value.platformBlocks.releases.map(
      (release) => `${release.blockId}@${release.releaseVersion}`,
    );
    if (new Set(blockIdentities).size !== blockIdentities.length)
      context.addIssue({
        code: "custom",
        path: ["platformBlocks", "releases"],
        message: "A compile snapshot may contain each exact platform block release only once",
      });
    const blockOrder = value.platformBlocks.releases.map((release) => ({
      blockId: String(release.blockId),
      releaseVersion: String(release.releaseVersion),
    }));
    if (!deterministicDependencyList(blockOrder))
      context.addIssue({
        code: "custom",
        path: ["platformBlocks", "releases"],
        message: "Compile snapshot block releases must use permanent-identity order",
      });
  });

export type ApplicationCompositionCatalogueSnapshot = z.infer<
  typeof applicationCompositionCatalogueSnapshotSchema
>;
