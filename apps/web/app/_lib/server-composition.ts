import "server-only";

import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
} from "@vortex/access";
import { createAppTelemetryCollector, createOperationsAlertSink } from "@vortex/app";
import type { IdentityAuthorityId } from "@vortex/contracts";
import { getIdentityAuthorityConfiguration } from "../auth/_lib/authority-configuration";

export const appTelemetry = createAppTelemetryCollector({ downstream: createOperationsAlertSink() });

export const humanOrganizationRequestDependencies = (
  identityAuthorityId: IdentityAuthorityId = getIdentityAuthorityConfiguration().authorityId,
): HumanOrganizationRequestDependencies => ({ identityAuthorityId, telemetry: appTelemetry });

export const humanOrganizationRequests = (identityAuthorityId?: IdentityAuthorityId) =>
  createHumanOrganizationRequestService(humanOrganizationRequestDependencies(identityAuthorityId));
