import "server-only";

import {
  isReservedTenantSegment,
  readPermittedApplicationsAtAddress,
  resolvePermittedApplicationAddress,
  type PermittedApplication,
  type PermittedApplicationsRead,
} from "@vortex/app";
import { loadPermittedApplicationsAtAddress } from "./organization-context";
import { getIdentityAuthorityConfiguration } from "../auth/_lib/authority-configuration";
import type { IdentitySession } from "@vortex/contracts";

export type ApplicationAddressResult =
  | Readonly<{ kind: "unavailable"; application?: PermittedApplication }>
  | Readonly<{ kind: "temporarily_unavailable" }>
  | Readonly<{
      kind: "organization_launcher";
      read: Extract<PermittedApplicationsRead, { kind: "available" }>;
    }>
  | Readonly<{
      kind: "application_page";
      /** Addressed read: holds only the addressed application and no organisation default. */
      read: Extract<PermittedApplicationsRead, { kind: "available" }>;
      application: PermittedApplication;
      pageKey: string;
    }>;

const loadAddressedApplicationAtAddress = async (
  session: IdentitySession,
  tenantShortName: string,
  organizationShortName: string,
  applicationKey: string,
): Promise<PermittedApplicationsRead> => {
  let authorityId;
  try {
    authorityId = getIdentityAuthorityConfiguration().authorityId;
  } catch {
    return { kind: "temporarily_unavailable" };
  }
  return readPermittedApplicationsAtAddress(
    session,
    tenantShortName,
    organizationShortName,
    authorityId,
    applicationKey,
  );
};

export const resolveApplicationAddress = async (
  session: IdentitySession,
  tenantShortName: string,
  organizationShortName: string,
  applicationKey?: string,
  pageKey?: string,
): Promise<ApplicationAddressResult> => {
  if (isReservedTenantSegment(tenantShortName)) return { kind: "unavailable" };

  // An addressed page request resolves only the named application. The launcher
  // keeps the full permitted list so it can still show every application.
  const read = applicationKey === undefined
    ? await loadPermittedApplicationsAtAddress(session, tenantShortName, organizationShortName)
    : await loadAddressedApplicationAtAddress(
        session, tenantShortName, organizationShortName, applicationKey,
      );
  if (read.kind !== "available") return read;

  const resolved = resolvePermittedApplicationAddress(read, applicationKey, pageKey);
  if (resolved.kind !== "available") {
    // Keep a resolvable application so the route can render that application's own
    // not-found experience; an unknown or refused application stays undisclosed.
    const application =
      applicationKey === undefined
        ? undefined
        : read.applications.find((entry) => entry.key === applicationKey);
    return application === undefined
      ? { kind: "unavailable" }
      : { kind: "unavailable", application };
  }
  if (resolved.application === null) return { kind: "organization_launcher", read };
  return {
    kind: "application_page",
    read,
    application: resolved.application,
    pageKey: resolved.pageKey,
  };
};
