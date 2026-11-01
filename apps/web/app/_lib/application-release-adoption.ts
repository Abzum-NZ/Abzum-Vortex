import "server-only";

import {
  createApplicationReleaseAdoptionTargetService,
  createBuilderAuthority,
  readCurrentOrganizationAppStoreAddressAfterAuthorization,
} from "@vortex/platform/server";
import type { ApplicationRootId, IdentitySession, OrganizationId } from "@vortex/platform/schema";
import { describeFailure } from "@vortex/platform/schema";
import { applicationPageAddressPath } from "./address-paths";
import { pageSubjectParameter } from "./application-page/placement-helpers";
import { applicationStoreService } from "./application-store-service";
import { humanOrganizationRequests } from "./server-composition";
import { platformPermissionSource } from "./platform-permission-source";

/**
 * Where an installed application stands against its latest published release. Publishing only
 * creates a release; the App Store is the one place an organisation installs or upgrades to it
 * (its Install or upgrade dialog reviews and accepts the role changes). These reads only say where
 * the application stands and link to that App Store page; nothing here changes an installation.
 */

/** The App Store page that shows one application and offers its Install or upgrade dialog. */
const appStoreApplicationPageKey = "app_store_application";

/** The App Store's page for one application: the store's record identity is the application root. */
const appStoreApplicationHref = (
  tenantShortName: string,
  organizationShortName: string,
  appStoreKey: string,
  applicationRootId: string,
): string =>
  `${applicationPageAddressPath(tenantShortName, organizationShortName, appStoreKey, appStoreApplicationPageKey)}?${pageSubjectParameter}=${encodeURIComponent(applicationRootId)}`;

/** A newer published release waiting for this organisation, offered to a person who may install. */
export type ApplicationReleaseOffer = Readonly<{
  version: string;
  installedVersion: string;
  appStoreHref: string;
}>;

type Address = Readonly<{ tenantShortName: string; organizationShortName: string }>;

/**
 * The newer published release of an installed application, with the link to its App Store page, or
 * undefined. Only a person who may manage this organisation's installations is told: their
 * `applications.manage` decision is made first in the same request, so nobody else reaches the
 * admin-only release read, and a refusal looks the same as "nothing waiting". A read that cannot be
 * made now is logged and offers nothing, so the application still opens.
 */
export const readApplicationReleaseOffer = async (
  session: IdentitySession,
  scope: Address &
    Readonly<{
      organizationId: OrganizationId;
      applicationRootId: ApplicationRootId;
      installedReleaseRevision: number;
      installedVersion: string;
    }>,
): Promise<ApplicationReleaseOffer | undefined> => {
  try {
    const result = await humanOrganizationRequests().run(
      session,
      { organizationId: scope.organizationId, applicationRootId: scope.applicationRootId },
      async (transaction, requestScope) => {
        const decision = await createBuilderAuthority({
          transaction,
          scope: requestScope,
          targetFacts: async () => ({ isSystemApplication: false }),
          permissions: platformPermissionSource,
        }).require({
          kind: "installation",
          applicationRootId: scope.applicationRootId,
          change: "install_or_upgrade",
          containsCustomComponents: false,
          acceptedPermissions: [],
        });
        if (decision.outcome !== "allowed") return undefined;
        const target = await createApplicationReleaseAdoptionTargetService(transaction).read({
          applicationRootId: scope.applicationRootId,
        });
        if (target === undefined || target.currentReleaseRevision <= scope.installedReleaseRevision)
          return undefined;
        const appStoreKey =
          await readCurrentOrganizationAppStoreAddressAfterAuthorization(transaction);
        if (appStoreKey === null || appStoreKey === "invalid") {
          console.error(`[release-offer] App Store address ${appStoreKey ?? "not set"}`);
          return undefined;
        }
        return {
          version: target.currentReleaseVersion,
          installedVersion: scope.installedVersion,
          appStoreHref: appStoreApplicationHref(
            scope.tenantShortName,
            scope.organizationShortName,
            appStoreKey,
            scope.applicationRootId,
          ),
        };
      },
    );
    if (result.kind === "available") return result.value;
    if (result.kind === "temporarily_unavailable")
      console.error(
        `[release-offer] read unavailable: ${result.databaseCode ?? result.cause ?? "unknown"}`,
      );
    return undefined;
  } catch (error) {
    console.error(`[release-offer] read failed: ${describeFailure(error)}`);
    return undefined;
  }
};

/** Where the application stands in the builder's organisation, as the App Store's review says it. */
export type ApplicationReleaseStanding =
  | Readonly<{ kind: "live"; version: string; rolesWaiting: boolean; appStoreHref: string }>
  | Readonly<{
      kind: "waiting";
      version: string;
      installedVersion: string;
      appStoreHref: string;
    }>
  | Readonly<{ kind: "not_installed"; version: string; appStoreHref: string }>
  | Readonly<{ kind: "not_published" }>
  /** The person may not manage installations here, or the review cannot be made now. */
  | Readonly<{ kind: "unknown"; appStoreHref?: string }>;

/**
 * The App Store's own review of the application for the signed-in person: whether its latest
 * release is live, waiting, or not installed in the organisation, and the App Store page that
 * installs or upgrades it. The review changes nothing.
 */
export const readApplicationReleaseStanding = async (
  session: IdentitySession,
  scope: Address &
    Readonly<{ organizationId: OrganizationId; applicationRootId: ApplicationRootId }>,
): Promise<ApplicationReleaseStanding> => {
  const appStore = await humanOrganizationRequests().run(
    session,
    { organizationId: scope.organizationId },
    (transaction) => readCurrentOrganizationAppStoreAddressAfterAuthorization(transaction),
  );
  const appStoreHref =
    appStore.kind === "available" && appStore.value !== null && appStore.value !== "invalid"
      ? appStoreApplicationHref(
          scope.tenantShortName,
          scope.organizationShortName,
          appStore.value,
          scope.applicationRootId,
        )
      : undefined;
  if (appStoreHref === undefined)
    console.error(
      `[release-standing] App Store address ${appStore.kind === "available" ? (appStore.value ?? "not set") : appStore.kind}`,
    );
  const review = await applicationStoreService().review(
    session,
    { organizationId: scope.organizationId },
    { application_root_id: scope.applicationRootId },
  );
  if (review === "conflict" || review === "uncertain" || review.kind !== "available") {
    const message = `[release-standing] review ${typeof review === "string" ? review : review.kind}`;
    // Every outcome but an uncertain one was classified, and logged with its cause where it arose.
    if (review === "uncertain") console.error(message);
    else console.info(message);
    return appStoreHref === undefined ? { kind: "unknown" } : { kind: "unknown", appStoreHref };
  }
  const value = review.value as Readonly<Record<string, unknown>>;
  const version = typeof value.release_version === "string" ? value.release_version : "";
  if (value.change === "unavailable" && value.reason === "not_published")
    return { kind: "not_published" };
  if (appStoreHref === undefined || version === "")
    return appStoreHref === undefined ? { kind: "unknown" } : { kind: "unknown", appStoreHref };
  switch (value.change) {
    case "current":
    case "roles":
      return { kind: "live", version, rolesWaiting: value.change === "roles", appStoreHref };
    case "upgrade":
      return {
        kind: "waiting",
        version,
        installedVersion:
          typeof value.installed_version === "string" ? value.installed_version : "",
        appStoreHref,
      };
    case "install":
      return { kind: "not_installed", version, appStoreHref };
    default:
      console.error(`[release-standing] review cannot install or upgrade: ${String(value.reason)}`);
      return { kind: "unknown", appStoreHref };
  }
};
