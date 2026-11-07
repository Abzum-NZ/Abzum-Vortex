import "server-only";

import type { IdentitySession } from "@vortex/platform/schema";
import { applicationPageAddressPath } from "./address-paths";
import { loadPermittedApplicationsAtAddress } from "./organization-context";

/** Where an application's home page is for this person: its address, or why there is none. */
export type ApplicationHomePath =
  | Readonly<{ kind: "path"; path: string }>
  /** Not installed here, or the person holds nothing that lets them open it. */
  | Readonly<{ kind: "not_permitted" }>
  | Readonly<{ kind: "unavailable" }>;

/**
 * The one place that finds an application's home page from its identity: the Open the application
 * button of a finished install, the editor's top bar and the flows' Navigate step all use it. The
 * application must be one the signed-in person may open now.
 */
export const applicationHomePathByRoot = async (
  session: IdentitySession,
  tenantShortName: string,
  organizationShortName: string,
  applicationRootId: string,
): Promise<ApplicationHomePath> => {
  const read = await loadPermittedApplicationsAtAddress(
    session,
    tenantShortName,
    organizationShortName,
  );
  // The permitted-applications read logged every answer that is not available, once.
  if (read.kind !== "available") return { kind: "unavailable" };
  const application = read.applications.find(
    (candidate) => candidate.applicationRootId.toLowerCase() === applicationRootId.toLowerCase(),
  );
  return application === undefined
    ? { kind: "not_permitted" }
    : {
        kind: "path",
        path: applicationPageAddressPath(
          tenantShortName,
          organizationShortName,
          application.key,
          application.homePageKey,
        ),
      };
};
