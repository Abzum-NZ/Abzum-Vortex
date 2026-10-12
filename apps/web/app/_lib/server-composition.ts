import "server-only";

import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
} from "@web/platform-server";
import { createAppTelemetryCollector, createOperationsAlertSink } from "@web/platform-server";
import type { IdentityAuthorityId } from "@vortex/platform/schema";
import { getIdentityAuthorityConfiguration } from "../auth/_lib/authority-configuration";

export const appTelemetry = createAppTelemetryCollector({ downstream: createOperationsAlertSink() });

export const humanOrganizationRequestDependencies = (
  identityAuthorityId: IdentityAuthorityId = getIdentityAuthorityConfiguration().authorityId,
): HumanOrganizationRequestDependencies => ({ identityAuthorityId, telemetry: appTelemetry });

export const humanOrganizationRequestsFor = (dependencies: HumanOrganizationRequestDependencies) =>
  createHumanOrganizationRequestService(dependencies);

export const humanOrganizationRequests = (identityAuthorityId?: IdentityAuthorityId) =>
  humanOrganizationRequestsFor(humanOrganizationRequestDependencies(identityAuthorityId));
