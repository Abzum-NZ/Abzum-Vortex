import "server-only";

import {
  createInstalledContextLoader,
  type HumanOrganizationRequestDependencies,
} from "@vortex/platform/server";
import type { IdentitySession, OrganizationSelectionCandidate } from "@vortex/platform/schema";
import {
  humanOrganizationRequestDependencies,
  humanOrganizationRequests,
} from "../server-composition";

export const requestDependencies = (): HumanOrganizationRequestDependencies =>
  humanOrganizationRequestDependencies();

/** The exact installed runtime context, read once under the person's own verified request scope. */
export const loadInstalledContext = (
  session: IdentitySession,
  dependencies: HumanOrganizationRequestDependencies,
  selection: OrganizationSelectionCandidate,
) =>
  humanOrganizationRequests(dependencies.identityAuthorityId).run(
    session,
    selection,
    async (transaction, scope) => {
      if (scope.applicationRootId === undefined) throw new Error("APPLICATION_SCOPE_UNAVAILABLE");
      return createInstalledContextLoader(transaction, scope).load();
    },
  );
