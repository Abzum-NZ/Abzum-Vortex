import "server-only";

import type { IdentitySession } from "@vortex/platform/schema";
import { applicationPageAddressPath, organizationAddressPath } from "./address-paths";
import { loadPermittedApplicationsAtAddress } from "./organization-context";

/**
 * Where opening an organisation lands in one response: its default application's home page, or
 * its launcher when it has no default application (or it cannot be read now, which the launcher
 * address then reports). Links and replies name this final page, never the organisation address
 * that would redirect again.
 */
export const resolveOrganizationLandingPath = async (
  session: IdentitySession,
  tenantShortName: string,
  organizationShortName: string,
): Promise<string> => {
  const read = await loadPermittedApplicationsAtAddress(
    session,
    tenantShortName,
    organizationShortName,
  );
  const application =
    read.kind !== "available" || read.defaultApplicationRootId === null
      ? undefined
      : read.applications.find(
          (candidate) => candidate.applicationRootId === read.defaultApplicationRootId,
        );
  return application === undefined
    ? organizationAddressPath(tenantShortName, organizationShortName)
    : applicationPageAddressPath(
        tenantShortName,
        organizationShortName,
        application.key,
        application.homePageKey,
      );
};
