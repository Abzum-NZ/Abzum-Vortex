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

/**
 * The application catalogue's install and upgrade journeys for one request: the installed release
 * catalogue and permissions, and the person's own request transactions and Access operations.
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
  });
