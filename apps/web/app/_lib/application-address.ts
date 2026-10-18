import "server-only";

import { cache } from "react";
import {
  isReservedTenantSegment,
  readAddressedApplicationFromInstalledBundleAtAddress,
  resolvePermittedApplicationAddress,
  type AddressedApplicationBundleRead,
  type ApplicationExperience,
  type InstalledRuntimeContext,
  type PermittedApplication,
  type PermittedApplicationsRead,
} from "@vortex/platform/server";
import { loadPermittedApplicationsAtAddress } from "./organization-context";
import { getIdentityAuthorityConfiguration } from "../auth/_lib/authority-configuration";
import type { IdentitySession } from "@vortex/platform/schema";
import { platformPermissionSource } from "./platform-permission-source";
import { mapWebError } from "./web-error-mapper";

type ApplicationAddressResult =
  | Readonly<{
      kind: "unavailable";
      /**
       * The addressed application's own not-found page, present only when the viewer may open
       * that application. A refused page and a missing page of it both carry the same page.
       */
      experience?: ApplicationExperience;
      /**
       * The addressed application, present only when the viewer may open it but not this page (or
       * the page does not exist), so the refusal can lead back into the application.
       */
      application?: PermittedApplication;
    }>
  | Readonly<{ kind: "temporarily_unavailable" }>
  | Readonly<{ kind: "suspended_super_administrator_account" }>
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
      /**
       * The exact installed bundle context this request's own HUMAN read authorized the
       * application against. The page loader reuses it instead of reading the bundle again.
       */
      installedContext?: InstalledRuntimeContext;
    }>;

// One addressed read per server render: the layout and the page of one request share it.
const loadAddressedApplicationAtAddress = cache(
  async (
    session: IdentitySession,
    tenantShortName: string,
    organizationShortName: string,
    applicationKey: string,
  ): Promise<AddressedApplicationBundleRead> => {
    let authorityId;
    try {
      authorityId = getIdentityAuthorityConfiguration().authorityId;
    } catch (error) {
      return mapWebError<AddressedApplicationBundleRead>(error, {
        route: "application-address",
        operation: "load_addressed_application",
        code: "identity_authority_configuration_failed",
        fallback: { read: { kind: "temporarily_unavailable" }, experiences: [] },
      });
    }
    return readAddressedApplicationFromInstalledBundleAtAddress(
      platformPermissionSource,
      session,
      tenantShortName,
      organizationShortName,
      authorityId,
      applicationKey,
    );
  },
);

export const resolveApplicationAddress = cache(
  async (
    session: IdentitySession,
    tenantShortName: string,
    organizationShortName: string,
    applicationKey?: string,
    pageKey?: string,
  ): Promise<ApplicationAddressResult> => {
    if (isReservedTenantSegment(tenantShortName)) return { kind: "unavailable" };

    // An addressed page request resolves only the named application. The launcher
    // keeps the full permitted list so it can still show every application.
    const addressed: AddressedApplicationBundleRead =
      applicationKey === undefined
        ? {
            read: await loadPermittedApplicationsAtAddress(
              session,
              tenantShortName,
              organizationShortName,
            ),
            experiences: [],
          }
        : await loadAddressedApplicationAtAddress(
            session,
            tenantShortName,
            organizationShortName,
            applicationKey,
          );
    const read = addressed.read;
    if (read.kind !== "available") return read;

    const resolved = resolvePermittedApplicationAddress(read, applicationKey, pageKey);
    if (resolved.kind !== "available") {
      // Experiences are carried only for an application the viewer may open, so an unknown or
      // refused application falls back to the neutral page and discloses nothing about itself.
      const experience = addressed.experiences.find((entry) => entry.state === "not_found");
      const application = read.applications.find((entry) => entry.key === applicationKey);
      return {
        kind: "unavailable",
        ...(experience === undefined ? {} : { experience }),
        ...(application === undefined ? {} : { application }),
      };
    }
    if (resolved.application === null) return { kind: "organization_launcher", read };
    return {
      kind: "application_page",
      read,
      application: resolved.application,
      pageKey: resolved.pageKey,
      ...(addressed.context === undefined ? {} : { installedContext: addressed.context }),
    };
  },
);
