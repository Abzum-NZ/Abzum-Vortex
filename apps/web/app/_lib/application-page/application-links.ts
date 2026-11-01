import "server-only";

import type { ApplicationLinkRow, ApplicationLinkTarget } from "@vortex/platform/schema";
import type { ApplicationSurfaceCapabilities } from "@vortex/platform/server";
import type { OrganizationId } from "@vortex/platform/schema";
import type { IdentitySession } from "@vortex/platform/schema";
import { appStoreApplicationHref } from "../application-release-adoption";
import { applicationPageAddressPath } from "../address-paths";
import { loadOrganizationAppStoreKey } from "../applications-page";

/**
 * What the viewer's application surfaces may offer: the one capability decision, which applications
 * they may open, and the one resolver that turns a declared link target into an address the person
 * is offered (or nothing). Every surface asks this; no renderer decides who sees what. Each
 * destination re-checks its own access when it opens, so an address grants nothing.
 */
export type ApplicationSurfaces = Readonly<{
  capabilities: ApplicationSurfaceCapabilities;
  isOpenable: (application: ApplicationLinkRow) => boolean;
  link: (
    target: ApplicationLinkTarget,
    application: ApplicationLinkRow | undefined,
  ) => string | undefined;
}>;

/** What a link resolution needs: the organisation's address and the applications the viewer may open. */
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
  capabilities: ApplicationSurfaceCapabilities,
): Promise<ApplicationSurfaces> => {
  const appStoreKey = await loadOrganizationAppStoreKey(session, organizationId);
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
          if (application === undefined) return undefined;
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
          return application !== undefined && mayBuild(application)
            ? `/studio/${encodeURIComponent(organizationId)}/${encodeURIComponent(application.applicationRootId)}`
            : undefined;
        case "studio_new_application":
          return capabilities.mayBuild
            ? `/studio/${encodeURIComponent(organizationId)}/new`
            : undefined;
        case "app_store_upgrade":
          return application !== undefined &&
            capabilities.mayInstall &&
            application.status === "update_available" &&
            appStoreKey !== undefined
            ? appStoreApplicationHref(
                address.tenantShortName,
                address.organizationShortName,
                appStoreKey,
                application.applicationRootId,
              )
            : undefined;
      }
    },
  };
};
