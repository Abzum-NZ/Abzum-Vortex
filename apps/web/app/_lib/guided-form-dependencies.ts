import "server-only";

import { createInstalledContextLoader } from "@vortex/platform/server";
import type {
  BoundHumanOrganizationRequest,
  GuidedFormDependencies,
} from "@vortex/platform/server";
import { platformPermissionFor, platformPermissionOwnerId } from "@vortex/definitions";
import { getIdentityAuthorityConfiguration } from "../auth/_lib/authority-configuration";

/**
 * Binds the platform's guided form logic to this application: the installed release catalogue and
 * database composition, the configured identity authority and the shipped platform permissions.
 */
export const guidedFormDependencies = (
  boundRequest?: BoundHumanOrganizationRequest,
): GuidedFormDependencies => ({
  identityAuthorityId: getIdentityAuthorityConfiguration().authorityId,
  ...(boundRequest === undefined ? {} : { boundRequest }),
  readContext: async (transaction, scope) => {
    if (scope.applicationRootId === undefined) return undefined;
    return createInstalledContextLoader(transaction, scope).load();
  },
  platformPermissionFor,
  platformPermissionOwnerId,
});
