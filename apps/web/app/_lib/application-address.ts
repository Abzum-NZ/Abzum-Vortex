import "server-only";

import { cache } from "react";
import {
  isReservedTenantSegment,
  readAddressedApplicationFromInstalledBundleAtAddress,
  resolvePermittedApplicationAddress,
  type AddressedApplicationBundleRead,
  type ApplicationExperience,
  type ApplicationLauncherRead,
  type InstalledRuntimeContext,
  type PermittedApplication,
  type PermittedApplicationsRead,
} from "@vortex/platform/server";
import { loadPermittedApplicationsAtAddress } from "./organization-context";
import { getIdentityAuthorityConfiguration } from "../auth/_lib/authority-configuration";
import type { IdentitySession, ProjectedNavigation } from "@vortex/platform/schema";
import { platformPermissionSource } from "./platform-permission-source";
import { mapWebError } from "./web-error-mapper";
import { attributePageReadScope } from "./page-read-attribution";

type ApplicationAddressResult =
  /** No application the viewer may open: nothing about the address is disclosed. */
  | Readonly<{ kind: "unavailable" }>
  /**
   * An application the viewer may open whose addressed page is not open to them: `refused` when the
   * release has the page, `missing` when it has no page of that key. Only a missing page carries
   * the application's own not-found page, when it defines one.
   */
  | Readonly<{
      kind: "unavailable";
      application: PermittedApplication;
      page: "refused" | "missing";
      experience?: ApplicationExperience;
    }>
  | Readonly<{ kind: "temporarily_unavailable" }>
  | Readonly<{ kind: "suspended_super_administrator_account" }>
  | Readonly<{
      kind: "organization_launcher";
      read: Extract<ApplicationLauncherRead, { kind: "available" }>;
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
      /**
       * The application navigation the viewer may see, decided in the address request's own batch
       * with the page's access; absent for a placement refresh, which shows no menu.
       */
      navigation?: ProjectedNavigation;
    }>;

// One addressed read per server render: the layout and the page of one request share it.
const loadAddressedApplicationAtAddress = cache(
  async (
    session: IdentitySession,
    tenantShortName: string,
    organizationShortName: string,
    applicationKey: string,
    addressedPageKey?: string,
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
      addressedPageKey,
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
    // Placement refreshes return no navigation or experience, so decide only their page/home.
    pageProjection: "application" | "addressed" = "application",
  ): Promise<ApplicationAddressResult> => {
    if (isReservedTenantSegment(tenantShortName)) return { kind: "unavailable" };

    if (applicationKey === undefined) {
      const read = await loadPermittedApplicationsAtAddress(
        session,
        tenantShortName,
        organizationShortName,
      );
      return read.kind === "available" ? { kind: "organization_launcher", read } : read;
    }

    // An addressed page request resolves only the named application. The launcher
    // keeps the full permitted list so it can still show every application.
    const addressed = await loadAddressedApplicationAtAddress(
      session,
      tenantShortName,
      organizationShortName,
      applicationKey,
      pageProjection === "addressed" ? pageKey : undefined,
    );
    const read = addressed.read;
    if (read.kind !== "available") return read;

    const resolved = resolvePermittedApplicationAddress(read, applicationKey, pageKey);
    if (resolved.kind !== "available") {
      // An unknown or refused application falls back to the neutral page and discloses nothing
      // about itself. Inside an application the viewer may open, a page of the release they may
      // not open is refused; an address naming no page of the release is missing.
      const application = read.applications.find((entry) => entry.key === applicationKey);
      if (application === undefined) return { kind: "unavailable" };
      if (addressed.releasePageKeys === undefined)
        throw new Error("Addressed application read carries no release page keys");
      if (pageKey !== undefined && addressed.releasePageKeys.includes(pageKey))
        return { kind: "unavailable", application, page: "refused" };
      const experience = addressed.experiences.find((entry) => entry.state === "not_found");
      return {
        kind: "unavailable",
        application,
        page: "missing",
        ...(experience === undefined ? {} : { experience }),
      };
    }
    attributePageReadScope(read.organizationId, resolved.application.applicationRootId);
    return {
      kind: "application_page",
      read,
      application: resolved.application,
      pageKey: resolved.pageKey,
      ...(addressed.context === undefined ? {} : { installedContext: addressed.context }),
      ...(addressed.navigation === undefined ? {} : { navigation: addressed.navigation }),
    };
  },
);
