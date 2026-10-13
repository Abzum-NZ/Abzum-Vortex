import "server-only";

import { cache } from "react";
import type { IdentitySession, OrganizationLauncherResolution } from "@vortex/platform/schema";
import { readPermittedApplicationsAtAddress, type PermittedApplicationsRead } from "@vortex/platform/server";
import { createOrganizationLauncherService } from "@vortex/platform/server";
import { getIdentityAuthorityConfiguration } from "../auth/_lib/authority-configuration";
import { platformPermissionSource } from "./platform-permission-source";

const organizationLauncherService = createOrganizationLauncherService();

const describeFailure = (error: unknown): string => {
  const name = error instanceof Error ? error.name : typeof error;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code)
      : undefined;
  return code === undefined ? name : `${name}(${code})`;
};

// Both reads run once per server render for the same session and address. The next request reads
// again, so no authorization outlives the request that made it.
export const loadOrganizationLauncher = cache(
  async (session: IdentitySession): Promise<OrganizationLauncherResolution> =>
    organizationLauncherService.list(session),
);

export const loadPermittedApplicationsAtAddress = cache(
  async (
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
      platformPermissionSource,
      session,
      tenantShortName,
      organizationShortName,
      authorityId,
    );
  },
);
