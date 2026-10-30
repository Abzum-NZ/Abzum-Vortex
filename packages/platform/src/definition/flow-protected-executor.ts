import "server-only";

import { createOrganizationAccessAdministrationService } from "../access/organization-access-administration-access";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
} from "../access/human-organization-request";
import { changeConnectionInstance } from "../connections/connection-administration";
import { checkConnectionHealth } from "../connections/connection-health";
import { createRequestBoundTenantGovernanceService } from "../identity/tenant-governance-request-bound";
import type { FlowReceiptClaim } from "../workflows/start";
import type { ApplicationStoreService } from "./installation-application-store";
import { createProtectedOperationExecutor } from "./protected-operation-executor";

/**
 * The one protected-operation executor a flow's Call protected operation task runs through, over a
 * request's dependencies (a page-bound request or a back-end run's own).
 */
export const createFlowProtectedExecutor = (
  scopedDependencies: HumanOrganizationRequestDependencies,
  applicationStore: ApplicationStoreService,
  receipt?: FlowReceiptClaim,
) => {
  const scopedRequests = createHumanOrganizationRequestService(scopedDependencies);
  return createProtectedOperationExecutor({
    accessAdministration: createOrganizationAccessAdministrationService(scopedDependencies),
    connectionAdministration: (session, selection, change) =>
      scopedRequests.runChange(session, selection, (transaction) =>
        changeConnectionInstance(transaction, change),
      ),
    connectionHealth: (session, selection, command) =>
      scopedRequests.runChange(session, selection, (transaction, scope) =>
        checkConnectionHealth(transaction, scope, command),
      ),
    applicationStore,
    ...(receipt === undefined ? {} : { receipt }),
    tenantGovernance: {
      run: (session, selection, operation) =>
        scopedRequests.runAccessChange(session, selection, (transaction, scope) =>
          operation({
            tenantId: scope.tenantId,
            operations: createRequestBoundTenantGovernanceService(transaction, scope),
          }),
        ),
    },
  });
};
