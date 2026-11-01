import "server-only";

import {
  IMMUTABLE_PLATFORM_BLOCK_CATALOGUE,
  createApplicationStoreService,
  createOrganizationAccessAdministrationService,
  type ApplicationStoreService,
} from "@vortex/platform/server";
import {
  installedReleaseCatalogue,
  releaseSetContainsCustomComponents,
} from "./definition-catalogue";
import { platformPermissionSource } from "./platform-permission-source";
import { minimumApplicationSource } from "../studio/_lib/minimum-application-source";
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
    // The starting frame of a new application is built where the editor builds every frame.
    newApplicationSource: (inputs) => {
      const built = minimumApplicationSource(inputs, IMMUTABLE_PLATFORM_BLOCK_CATALOGUE);
      return built.kind === "valid" ? { kind: "valid", source: built.source } : { kind: "invalid" };
    },
    requests: humanOrganizationRequests(),
    accessAdministration: createOrganizationAccessAdministrationService(
      humanOrganizationRequestDependencies(),
    ),
    bindAccessAdministration: (boundRequest) =>
      createOrganizationAccessAdministrationService({
        ...humanOrganizationRequestDependencies(),
        boundRequest,
      }),
  });
