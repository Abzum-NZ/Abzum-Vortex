import "server-only";

import {
  currentPlatformPermissions,
  historicalPlatformPermissionsV1,
  historicalPlatformPermissionsV1_0_1,
  platformPermissionCatalogueOwnerId,
  platformPermissionCatalogueVersion,
  platformPermissionCatalogueVersionV1,
  platformPermissionCatalogueVersionV1_0_1,
  platformPermissionCatalogueSchema,
  type PermissionDeclaration,
  type PlatformPermissionCatalogue,
} from "@vortex/contracts";
import { fingerprintCanonicalValue } from "@vortex/definition";

/**
 * The shipped platform permission catalogue, built from the immutable data in Contracts.
 *
 * The permission identities, keys, labels, descriptions, action kinds and versions live in
 * `@vortex/contracts`, the shared lowest layer, so Definition can validate platform-permission
 * references without importing Access. Access derives each release's catalogue fingerprint here
 * from that same data, exactly as the platform registration revisions expect, so no published
 * fingerprint changes.
 */
export {
  platformPermissionCatalogueOwnerId,
  platformPermissionCatalogueVersion,
  platformPermissionCatalogueVersionV1,
  platformPermissionCatalogueVersionV1_0_1,
};

const buildCatalogue = (
  catalogueVersion: string,
  permissions: readonly PermissionDeclaration[],
): PlatformPermissionCatalogue => {
  const catalogueCore = {
    catalogueVersion,
    ownerKind: "platform" as const,
    ownerId: platformPermissionCatalogueOwnerId,
    permissions,
  };
  return platformPermissionCatalogueSchema.parse({
    ...catalogueCore,
    catalogueFingerprint: fingerprintCanonicalValue(catalogueCore),
  });
};

/** Immutable historical metadata installed by the original platform initializer. */
export const platformPermissionCatalogueV1 = buildCatalogue(
  platformPermissionCatalogueVersionV1,
  historicalPlatformPermissionsV1,
);

/** Immutable Group-facing metadata revision. */
export const platformPermissionCatalogueV1_0_1 = buildCatalogue(
  platformPermissionCatalogueVersionV1_0_1,
  historicalPlatformPermissionsV1_0_1,
);

/**
 * Current additive catalogue, mirroring platform registration revision 6 (1.4.0): its
 * fingerprint equals that revision's catalogue fingerprint. Historical permission
 * identities and meanings remain unchanged; 1.4.0 adds only the four builder permissions
 * to the 1.3.0 set. Registering them grants nobody authority.
 */
export const platformPermissionCatalogue = buildCatalogue(
  platformPermissionCatalogueVersion,
  currentPlatformPermissions,
);
