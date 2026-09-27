import "server-only";

import {
  currentPlatformPermissions,
  platformPermissionCatalogueOwnerId,
  platformPermissionCatalogueVersion,
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
 * references without importing Access. Access derives the current catalogue fingerprint here
 * from that same data, exactly as the current platform registration revision expects.
 */
export { platformPermissionCatalogueOwnerId, platformPermissionCatalogueVersion };

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
