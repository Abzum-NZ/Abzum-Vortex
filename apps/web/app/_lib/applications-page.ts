import "server-only";

import { readCurrentOrganizationAppStoreAddressAfterAuthorization } from "@vortex/platform/server";
import type { IdentitySession, OrganizationId } from "@vortex/platform/schema";
import { applicationPageAddressPath } from "./address-paths";
import { humanOrganizationRequests } from "./server-composition";

/** The App Store's page that lists the organisation's applications; the one Applications page. */
export const applicationsPageKey = "app_store_catalogue";

/** One organisation as the launcher names it, with the addresses an Applications link needs. */
export type ApplicationsPageOrganization = Readonly<{
  organizationId: OrganizationId;
  tenantShortName: string;
  organizationShortName: string;
}>;

/**
 * The organisation's App Store application key, as the runtime settings name it; absent when the
 * organisation names none or it cannot be read now (the cause is logged, never shown as an address).
 */
export const loadOrganizationAppStoreKey = async (
  session: IdentitySession,
  organizationId: OrganizationId,
): Promise<string | undefined> => {
  const result = await humanOrganizationRequests().run(
    session,
    { organizationId },
    async (transaction) => {
      const key = await readCurrentOrganizationAppStoreAddressAfterAuthorization(transaction);
      return key === null || key === "invalid" ? undefined : key;
    },
  );
  if (result.kind !== "available") {
    console.error(
      `[applications-page] App Store address ${result.kind === "unavailable" ? (result.cause ?? result.kind) : result.kind}`,
    );
    return undefined;
  }
  return result.value;
};

/**
 * The Applications page of one organisation. Every former Studio home link names this final page,
 * so no link points at an address that would redirect again.
 */
export const loadApplicationsPageHref = async (
  session: IdentitySession,
  organization: ApplicationsPageOrganization,
): Promise<string | undefined> => {
  const key = await loadOrganizationAppStoreKey(session, organization.organizationId);
  return key === undefined
    ? undefined
    : applicationPageAddressPath(
        organization.tenantShortName,
        organization.organizationShortName,
        key,
        applicationsPageKey,
      );
};

/** The first organisation whose Applications page this person can be sent to, in launcher order. */
export const loadFirstApplicationsPageHref = async (
  session: IdentitySession,
  organizations: readonly ApplicationsPageOrganization[],
): Promise<string | undefined> => {
  for (const organization of organizations) {
    const href = await loadApplicationsPageHref(session, organization);
    if (href !== undefined) return href;
  }
  return undefined;
};
