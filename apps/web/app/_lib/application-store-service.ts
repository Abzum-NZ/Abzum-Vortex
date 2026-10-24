import "server-only";
import type { ProtectedOperationChannel } from "@vortex/platform/schema";

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
  humanOrganizationRequestsFor,
} from "./server-composition";

/**
 * The application catalogue's install and upgrade journeys for one request: the installed release
 * catalogue and permissions, and the person's own request transactions and Access operations.
 */
export const applicationStoreService = (
  channel: ProtectedOperationChannel = "web",
): ApplicationStoreService =>
  createApplicationStoreService({
    catalogue: installedReleaseCatalogue,
    permissions: platformPermissionSource,
    containsCustomComponents: releaseSetContainsCustomComponents,
    requests: humanOrganizationRequestsFor({ ...humanOrganizationRequestDependencies(), channel }),
    accessAdministration: createOrganizationAccessAdministrationService({
      ...humanOrganizationRequestDependencies(),
      channel,
    }),
  });
