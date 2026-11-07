import "server-only";

import { cache } from "react";
import { readCurrentOrganizationAppStoreAddressAfterAuthorization } from "@vortex/platform/server";
import {
  organizationSelectionCandidateSchema,
  type IdentitySession,
  type OrganizationId,
} from "@vortex/platform/schema";
import { applicationPageAddressPath } from "./address-paths";
import { humanOrganizationRequests } from "./server-composition";

/** The App Store's page that lists the organisation's applications; the one Applications page. */
const applicationsPageKey = "app_store";

/** One organisation as the launcher names it, with the addresses an Applications link needs. */
export type ApplicationsPageOrganization = Readonly<{
  organizationId: OrganizationId;
  tenantShortName: string;
  organizationShortName: string;
}>;

/**
 * The organisation's App Store address, as its runtime settings name it: one read per request and
 * organisation, shared by Studio's frame, the release standing, the Applications link and the
 * application links. A read that is not available was logged once by the request runner; an
 * address that is not set (or names no application) is a configuration an administrator fixes.
 */
export type OrganizationAppStoreAddress =
  | Readonly<{ kind: "available"; key: string }>
  | Readonly<{ kind: "not_configured"; invalid: boolean }>
  | Readonly<{ kind: "refused" | "temporarily_unavailable" }>;

export const loadOrganizationAppStoreAddress = cache(
  async (
    session: IdentitySession,
    organizationId: string,
  ): Promise<OrganizationAppStoreAddress> => {
    const result = await humanOrganizationRequests().run(
      session,
      organizationSelectionCandidateSchema.parse({ organizationId }),
      (transaction) => readCurrentOrganizationAppStoreAddressAfterAuthorization(transaction),
    );
    if (result.kind !== "available")
      return { kind: result.kind === "temporarily_unavailable" ? result.kind : "refused" };
    return result.value === null || result.value === "invalid"
      ? { kind: "not_configured", invalid: result.value === "invalid" }
      : { kind: "available", key: result.value };
  },
);

/** The organisation's App Store application key; absent when it names none or cannot be read now. */
export const loadOrganizationAppStoreKey = async (
  session: IdentitySession,
  organizationId: OrganizationId,
): Promise<string | undefined> => {
  const address = await loadOrganizationAppStoreAddress(session, organizationId);
  return address.kind === "available" ? address.key : undefined;
};

/** The Applications page of one organisation whose App Store is `key`. */
export const applicationsPageHref = (
  organization: Omit<ApplicationsPageOrganization, "organizationId">,
  key: string,
): string =>
  applicationPageAddressPath(
    organization.tenantShortName,
    organization.organizationShortName,
    key,
    applicationsPageKey,
  );

/**
 * The Applications page of one organisation. Every former Studio home link names this final page,
 * so no link points at an address that would redirect again.
 */
export const loadApplicationsPageHref = async (
  session: IdentitySession,
  organization: ApplicationsPageOrganization,
): Promise<string | undefined> => {
  const key = await loadOrganizationAppStoreKey(session, organization.organizationId);
  return key === undefined ? undefined : applicationsPageHref(organization, key);
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
