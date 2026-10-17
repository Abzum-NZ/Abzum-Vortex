import "server-only";

import {
  createApplicationStoreService,
  createOrganizationAccessAdministrationService,
  type ApplicationStoreService,
} from "@vortex/platform/server";
import {
  installedReleaseCatalogue,
  releaseSetContainsCustomComponents,
} from "./definition-catalogue";
import { platformPermissionSource } from "./platform-permission-source";
import {
  humanOrganizationRequestDependencies,
  humanOrganizationRequests,
} from "./server-composition";
import {
  inspectStudioApplicationReleaseHistory,
  loadStudioApplicationHistoryAccess,
} from "./studio-application-history";

/**
 * The application catalogue's install and upgrade journeys for one request: the installed release
 * catalogue and permissions, the person's own request transactions and Access operations, and the
 * draft history every install is anchored to.
 */
export const applicationStoreService = (): ApplicationStoreService =>
  createApplicationStoreService({
    catalogue: installedReleaseCatalogue,
    permissions: platformPermissionSource,
    containsCustomComponents: releaseSetContainsCustomComponents,
    requests: humanOrganizationRequests(),
    accessAdministration: createOrganizationAccessAdministrationService(
      humanOrganizationRequestDependencies(),
    ),
    history: {
      readAccess: loadStudioApplicationHistoryAccess,
      inspectRelease: inspectStudioApplicationReleaseHistory,
    },
  });
