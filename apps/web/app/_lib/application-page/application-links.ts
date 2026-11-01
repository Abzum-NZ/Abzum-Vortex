import "server-only";

import {
  applicationSurfaceCapabilitiesOf,
  readApplicationSurfaceCapabilities,
  readCurrentOrganizationAppStoreAddressAfterAuthorization,
} from "@vortex/platform/server";
import type { ApplicationLinkRow, ApplicationLinkTarget } from "@vortex/platform/schema";
import type { ApplicationSurfaceCapabilities } from "@vortex/platform/server";
import type { OrganizationId } from "@vortex/platform/schema";
import type { IdentitySession } from "@vortex/platform/schema";
import { applicationPageAddressPath } from "../address-paths";
import { pageSubjectParameter } from "./placement-helpers";
import {
  humanOrganizationRequestDependencies,
  humanOrganizationRequestsFor,
} from "../server-composition";
import { platformPermissionSource } from "../platform-permission-source";

/**
 * What the viewer's application surfaces may offer: the one capability decision, which applications
 * they may open, and the one resolver that turns a declared link target into an address the person
 * is offered (or nothing). Every surface asks this; no renderer decides who sees what. Each
 * destination re-checks its own access when it opens, so an address grants nothing.
 */
export type ApplicationSurfaces = Readonly<{
  capabilities: ApplicationSurfaceCapabilities;
  isOpenable: (application: ApplicationLinkRow) => boolean;
  link: (target: ApplicationLinkTarget, application: ApplicationLinkRow) => string | undefined;
}>;

type ApplicationSurfacesAddress = Readonly<{
  tenantShortName: string;
  organizationShortName: string;
  /** The applications the viewer may open, read once for this page. */
  openable: readonly Readonly<{
    applicationRootId: string;
    key: string;
    homePageKey: string;
  }>[];
}>;

/**
 * Builds the surfaces for one page read: the capability read over the person's own request, the one
 * address read that names the App Store, and the already-read permitted applications. A surface that
 * cannot be decided offers nothing (the capabilities read logs the cause) rather than guessing.
 */
export const loadApplicationSurfaces = async (
  session: IdentitySession,
  organizationId: OrganizationId,
  address: ApplicationSurfacesAddress,
): Promise<ApplicationSurfaces> => {
  const selection = { organizationId };
  const capabilities = applicationSurfaceCapabilitiesOf(
    await readApplicationSurfaceCapabilities(session, selection, {
      ...humanOrganizationRequestDependencies(),
      permissions: platformPermissionSource,
    }),
  );
  const appStoreKey = await readCurrentOrganizationAppStoreKey(session, organizationId);
  const openableByKey = new Map(
    address.openable.map(
      (entry) =>
        [
          entry.key.toLowerCase(),
          { rootId: entry.applicationRootId, homePageKey: entry.homePageKey },
        ] as const,
    ),
  );
  const isOpenable = (application: ApplicationLinkRow): boolean =>
    openableByKey.has(application.key.toLowerCase());
  const mayBuild = (application: ApplicationLinkRow): boolean =>
    application.isSystemApplication
      ? capabilities.mayBuildSystemApplications
      : capabilities.mayBuild;
  return {
    capabilities,
    isOpenable,
    link: (target, application) => {
      switch (target) {
        case "open_application": {
          const entry = openableByKey.get(application.key.toLowerCase());
          return entry === undefined
            ? undefined
            : applicationPageAddressPath(
                address.tenantShortName,
                address.organizationShortName,
                application.key,
                entry.homePageKey,
              );
        }
        case "studio_editor":
          return mayBuild(application)
            ? `/studio/${encodeURIComponent(organizationId)}/${encodeURIComponent(application.applicationRootId)}`
            : undefined;
        case "studio_new_application":
          return capabilities.mayBuild
            ? `/studio/${encodeURIComponent(organizationId)}/new`
            : undefined;
        case "app_store_upgrade":
          return capabilities.mayInstall &&
            application.status === "update_available" &&
            appStoreKey !== undefined
            ? applicationPageAddressPath(
                address.tenantShortName,
                address.organizationShortName,
                appStoreKey,
                appStoreApplicationPageKey,
              ) + `?${pageSubjectParameter}=${encodeURIComponent(application.applicationRootId)}`
            : undefined;
      }
    },
  };
};

/** The App Store page that shows one application and offers its Install or upgrade dialog. */
const appStoreApplicationPageKey = "app_store_application";

/**
 * The App Store's application key at this organisation as the runtime settings name it; absent when
 * the organisation names none or it cannot be read now (logged, and the upgrade link is not offered).
 */
const readCurrentOrganizationAppStoreKey = async (
  session: IdentitySession,
  organizationId: OrganizationId,
): Promise<string | undefined> => {
  const result = await humanOrganizationRequestsFor(humanOrganizationRequestDependencies()).run(
    session,
    { organizationId },
    async (transaction) => {
      const key = await readCurrentOrganizationAppStoreAddressAfterAuthorization(transaction);
      return key === null || key === "invalid" ? undefined : key;
    },
  );
  if (result.kind === "available") return result.value;
  console.error(
    `[application-surfaces] App Store address ${result.kind === "unavailable" ? (result.cause ?? result.kind) : result.kind}`,
  );
  return undefined;
};
