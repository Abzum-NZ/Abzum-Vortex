import "server-only";

import {
  resolvePermittedApplicationAddress,
  type PermittedApplication,
  type PermittedApplicationsRead,
} from "@vortex/app";
import { loadPermittedApplicationsAtAddress } from "./organization-context";
import type { IdentitySession } from "@vortex/contracts";

const reservedTenantSegments = new Set([
  "auth",
  "health",
  "organizations",
  "signed-in",
  "signin",
  "api",
]);

export type ApplicationAddressResult =
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "temporarily_unavailable" }>
  | Readonly<{
      kind: "organization_launcher";
      read: Extract<PermittedApplicationsRead, { kind: "available" }>;
    }>
  | Readonly<{
      kind: "application_page";
      read: Extract<PermittedApplicationsRead, { kind: "available" }>;
      application: PermittedApplication;
      pageKey: string;
    }>;

export const resolveApplicationAddress = async (
  session: IdentitySession,
  tenantShortName: string,
  organizationShortName: string,
  applicationKey?: string,
  pageKey?: string,
): Promise<ApplicationAddressResult> => {
  if (reservedTenantSegments.has(tenantShortName.toLowerCase())) return { kind: "unavailable" };

  const read = await loadPermittedApplicationsAtAddress(
    session,
    tenantShortName,
    organizationShortName,
  );
  if (read.kind !== "available") return read;

  const resolved = resolvePermittedApplicationAddress(read, applicationKey, pageKey);
  if (resolved.kind !== "available") return resolved;
  if (resolved.application === null) return { kind: "organization_launcher", read };
  return {
    kind: "application_page",
    read,
    application: resolved.application,
    pageKey: resolved.pageKey,
  };
};
