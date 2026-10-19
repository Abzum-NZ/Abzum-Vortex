import "server-only";

import { createHumanInstalledPageBundleContextLoader } from "@vortex/platform/server";
import type { GuidedFormDependencies } from "@vortex/platform/server";
import { platformPermissionFor, platformPermissionOwnerId } from "@vortex/definitions";
import { getIdentityAuthorityConfiguration } from "../auth/_lib/authority-configuration";

/**
 * Binds the platform's guided form logic to this application: the installed release catalogue and
 * database composition, the configured identity authority and the shipped platform permissions.
 */
export const guidedFormDependencies = (): GuidedFormDependencies => ({
  identityAuthorityId: getIdentityAuthorityConfiguration().authorityId,
  readContext: async (transaction, scope) => {
    if (scope.applicationRootId === undefined) return undefined;
    return createHumanInstalledPageBundleContextLoader({
      transaction,
      scope: {
        organizationId: scope.organizationId,
        organizationAccountId: scope.organizationAccountId,
        applicationRootId: scope.applicationRootId,
        ...(scope.previewInstallationId === undefined
          ? {}
          : { previewInstallationId: scope.previewInstallationId }),
      },
    }).load();
  },
  platformPermissionFor,
  platformPermissionOwnerId,
});
