import "server-only";

import {
  createActiveApplicationInstallationRepository,
  createDatabaseApplicationBoundReleaseSetService,
  createHumanInstalledRuntimeContextLoader,
} from "@web/platform-server";
import type { GuidedFormDependencies } from "@vortex/platform/server";
import { platformPermissionFor, platformPermissionOwnerId } from "@vortex/definitions";
import { getIdentityAuthorityConfiguration } from "../auth/_lib/authority-configuration";
import { installedReleaseCatalogue } from "./definition-catalogue";

/**
 * Binds the platform's guided form logic to this application: the installed release catalogue and
 * database composition, the configured identity authority and the shipped platform permissions.
 */
export const guidedFormDependencies = (): GuidedFormDependencies => ({
  identityAuthorityId: getIdentityAuthorityConfiguration().authorityId,
  readContext: async (transaction, scope) => {
    if (scope.applicationRootId === undefined) return undefined;
    return createHumanInstalledRuntimeContextLoader({
      activeInstallationReader: createActiveApplicationInstallationRepository(transaction),
      releaseSetReader: createDatabaseApplicationBoundReleaseSetService(
        installedReleaseCatalogue,
        transaction,
      ),
      scope: {
        organizationId: scope.organizationId,
        applicationRootId: scope.applicationRootId,
      },
    }).load();
  },
  platformPermissionFor,
  platformPermissionOwnerId,
});
