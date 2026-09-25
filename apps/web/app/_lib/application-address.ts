import "server-only";

import {
  isReservedTenantSegment,
  readAddressedApplicationAtAddress,
  resolvePermittedApplicationAddress,
  type AddressedApplicationRead,
  type ApplicationExperience,
  type PermittedApplication,
  type PermittedApplicationsRead,
} from "@vortex/app";
import { loadPermittedApplicationsAtAddress } from "./organization-context";
import { getIdentityAuthorityConfiguration } from "../auth/_lib/authority-configuration";
import type { IdentitySession } from "@vortex/contracts";

export type ApplicationAddressResult =
  | Readonly<{
      kind: "unavailable";
      /**
       * The addressed application's own not-found page, present only when the viewer may open
       * that application. A refused page and a missing page of it both carry the same page.
       */
      experience?: ApplicationExperience;
    }>
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
): Promise<AddressedApplicationRead> => {
  let authorityId;
  try {
    authorityId = getIdentityAuthorityConfiguration().authorityId;
  } catch {
    return { read: { kind: "temporarily_unavailable" }, experiences: [] };
  }
  return readAddressedApplicationAtAddress(
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
  const addressed: AddressedApplicationRead = applicationKey === undefined
    ? {
        read: await loadPermittedApplicationsAtAddress(
          session, tenantShortName, organizationShortName,
        ),
        experiences: [],
      }
    : await loadAddressedApplicationAtAddress(
        session, tenantShortName, organizationShortName, applicationKey,
      );
  const read = addressed.read;
  if (read.kind !== "available") return read;

  const resolved = resolvePermittedApplicationAddress(read, applicationKey, pageKey);
  if (resolved.kind !== "available") {
    // Experiences are carried only for an application the viewer may open, so an unknown or
    // refused application falls back to the neutral page and discloses nothing about itself.
    const experience = addressed.experiences.find((entry) => entry.state === "not_found");
    return experience === undefined ? { kind: "unavailable" } : { kind: "unavailable", experience };
  }
  if (resolved.application === null) return { kind: "organization_launcher", read };
  return {
    kind: "application_page",
    read,
    application: resolved.application,
    pageKey: resolved.pageKey,
  };
};
