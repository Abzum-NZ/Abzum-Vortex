import "server-only";

import type { IdentitySession } from "@vortex/platform/schema";
import { applicationPageAddressPath } from "./address-paths";
import {
  loadOrganizationLauncher,
  loadPermittedApplicationsAtAddress,
} from "./organization-context";

/**
 * Where a signed-in person lands in one response: the one available organisation's default
 * application page, when there is exactly one organisation and it has a default application.
 * Undefined leaves the chooser in charge. The caller supplies the session its action just
 * committed, so the landing never re-reads a session the request did not yet carry.
 */
export const resolveSignedInLandingPath = async (
  session: IdentitySession,
): Promise<string | undefined> => {
  const launcher = await loadOrganizationLauncher(session);
  if (launcher.kind !== "available" || launcher.entries.length !== 1) return undefined;
  const entry = launcher.entries[0];
  if (entry === undefined) return undefined;
  const read = await loadPermittedApplicationsAtAddress(
    session,
    entry.tenantShortName,
    entry.organizationShortName,
  );
  if (read.kind !== "available" || read.defaultApplicationRootId === null) return undefined;
  const application = read.applications.find(
    (candidate) => candidate.applicationRootId === read.defaultApplicationRootId,
  );
  if (application === undefined) return undefined;
  return applicationPageAddressPath(
    entry.tenantShortName,
    entry.organizationShortName,
    application.key,
    application.homePageKey,
  );
};
