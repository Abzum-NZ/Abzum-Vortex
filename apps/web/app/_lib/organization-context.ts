import "server-only";

import { type IdentitySession, type OrganizationLauncherResolution } from "@vortex/contracts";
import {
  readPermittedApplicationsAtAddress,
  type PermittedApplicationsRead,
} from "@vortex/app";
import { listOrganizationLauncher } from "@vortex/identity";
import { getIdentityAuthorityConfiguration } from "../auth/_lib/authority-configuration";

export const loadOrganizationLauncher = async (
  session: IdentitySession,
): Promise<OrganizationLauncherResolution> => listOrganizationLauncher(session);

export const loadPermittedApplicationsAtAddress = async (
  session: IdentitySession,
  tenantShortName: string,
  organizationShortName: string,
): Promise<PermittedApplicationsRead> => {
  let authorityId;
  try {
    authorityId = getIdentityAuthorityConfiguration().authorityId;
  } catch {
    return { kind: "temporarily_unavailable" };
  }
  return readPermittedApplicationsAtAddress(
    session, tenantShortName, organizationShortName, authorityId,
  );
};
