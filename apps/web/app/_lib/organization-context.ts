import "server-only";

import type { IdentitySession, OrganizationLauncherResolution } from "@vortex/contracts";
import { readPermittedApplicationsAtAddress, type PermittedApplicationsRead } from "@vortex/app";
import { createOrganizationLauncherService } from "@vortex/identity";
import { getIdentityAuthorityConfiguration } from "../auth/_lib/authority-configuration";

const organizationLauncherService = createOrganizationLauncherService();

const describeFailure = (error: unknown): string => {
  const name = error instanceof Error ? error.name : typeof error;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code)
      : undefined;
  return code === undefined ? name : `${name}(${code})`;
};

export const loadOrganizationLauncher = async (
  session: IdentitySession,
): Promise<OrganizationLauncherResolution> => organizationLauncherService.list(session);

export const loadPermittedApplicationsAtAddress = async (
  session: IdentitySession,
  tenantShortName: string,
  organizationShortName: string,
): Promise<PermittedApplicationsRead> => {
  let authorityId;
  try {
    authorityId = getIdentityAuthorityConfiguration().authorityId;
  } catch (error) {
    return { kind: "temporarily_unavailable", cause: describeFailure(error) };
  }
  return readPermittedApplicationsAtAddress(
    session,
    tenantShortName,
    organizationShortName,
    authorityId,
  );
};
