import "server-only";

import {
  readAddressedApplicationFromInstalledBundleAtAddress,
  matchesInstalledPageBundleIdentity,
  requireInstalledRuntimeContext,
  resolveInstalledPageIdentity,
  resolvePermittedApplicationAddress,
} from "@vortex/app";
import {
  applicationPageLinkResultSchema,
  applicationPageLinkSelectorSchema,
  builderKeySchema,
  sameId,
  type ApplicationPageLinkResult,
  type IdentitySession,
} from "@vortex/contracts";
import { createDatabaseApplicationBoundReleaseSetService } from "@vortex/definition";
import { createActiveInstallationBundleRepository } from "@vortex/module";
import { createStoredPageCapabilityService } from "@vortex/page";
import { installedReleaseCatalogue } from "./definition-catalogue";
import {
  humanOrganizationRequestDependencies,
  humanOrganizationRequestsFor,
} from "./server-composition";

const unavailable = Object.freeze({ availability: "unavailable" as const });

/** The server binds this address; a browser selector cannot choose another organization. */
export type ApplicationPageLinkAddress = Readonly<{
  tenantShortName: string;
  organizationShortName: string;
}>;

/**
 * Each read proves one current target under the signed person's own authority. The detached
 * result is a point-in-time candidate, not an atomic snapshot or permission to activate later.
 */
export const createApplicationPageLinkReader = (address: ApplicationPageLinkAddress) => {
  const boundAddress = Object.freeze({
    tenantShortName: address.tenantShortName,
    organizationShortName: address.organizationShortName,
  });

  return Object.freeze({
    async read(session: IdentitySession, candidate: unknown): Promise<ApplicationPageLinkResult> {
      try {
        const selector = applicationPageLinkSelectorSchema.safeParse(candidate);
        const tenantShortName = builderKeySchema.safeParse(boundAddress.tenantShortName);
        const organizationShortName = builderKeySchema.safeParse(boundAddress.organizationShortName);
        if (!selector.success || !tenantShortName.success || !organizationShortName.success)
          return unavailable;

        const dependencies = humanOrganizationRequestDependencies();
        const addressed = await readAddressedApplicationFromInstalledBundleAtAddress(
          session,
          tenantShortName.data,
          organizationShortName.data,
          dependencies.identityAuthorityId,
          selector.data.applicationKey,
          (transaction) => createDatabaseApplicationBoundReleaseSetService(
            installedReleaseCatalogue,
            transaction,
          ),
        );
        const { read, context, identity: addressIdentity } = addressed;
        if (
          read.kind !== "available" ||
          context === undefined ||
          addressIdentity === undefined ||
          read.organizationId !== addressIdentity.organizationId ||
          read.tenantShortName !== tenantShortName.data ||
          read.organizationShortName !== organizationShortName.data ||
          read.applications.length !== 1
        )
          return unavailable;

        const addressedIdentity = addressIdentity.identity;

        const target = resolvePermittedApplicationAddress(
          read,
          selector.data.applicationKey,
          selector.data.kind === "page" ? selector.data.pageKey : undefined,
        );
        if (
          target.kind !== "available" ||
          target.application === null ||
          target.pageKey === null ||
          target.application.key !== selector.data.applicationKey ||
          !sameId(target.application.applicationRootId, addressedIdentity.applicationRootId)
        )
          return unavailable;

        const permittedApplication = target.application;
        const selection = {
          organizationId: read.organizationId,
          applicationRootId: addressedIdentity.applicationRootId,
        };
        const installedContext = requireInstalledRuntimeContext(context);
        const application = installedContext.releaseSet.application;
        if (
          !sameId(installedContext.organizationId, read.organizationId) ||
          !sameId(installedContext.applicationRootId, addressedIdentity.applicationRootId) ||
          !sameId(application.organizationId, installedContext.organizationId) ||
          !sameId(application.rootId, installedContext.applicationRootId) ||
          application.releaseRevision !== addressedIdentity.applicationReleaseRevision ||
          application.definitionKey !== addressedIdentity.definitionKey ||
          application.definitionKey !== selector.data.applicationKey ||
          application.releaseRevision !== installedContext.applicationReleaseRevision ||
          application.content.name !== permittedApplication.name ||
          application.content.icon !== permittedApplication.icon
        )
          return unavailable;

        const pages = application.content.pages.filter((page) => page.key === target.pageKey);
        if (pages.length !== 1) return unavailable;
        const page = pages[0];
        if (page === undefined) return unavailable;
        const identity = resolveInstalledPageIdentity(installedContext, { pageId: page.pageId });
        if (
          identity === undefined ||
          !sameId(identity.organizationId, installedContext.organizationId) ||
          !sameId(identity.applicationRootId, installedContext.applicationRootId) ||
          !sameId(identity.requested.pageId, page.pageId) ||
          identity.requested.key !== page.key ||
          identity.applicationReleaseRevision !== installedContext.applicationReleaseRevision ||
          identity.releaseVersion !== application.releaseVersion ||
          identity.contentFingerprint !== application.contentFingerprint ||
          identity.resolutionFingerprint !== application.resolutionFingerprint
        )
          return unavailable;

        const projected = await createStoredPageCapabilityService({
          ...dependencies,
          context: installedContext,
          selection: { pageId: page.pageId },
        }).project(session, selection);
        if (
          projected.kind !== "available" ||
          projected.value === undefined ||
          typeof projected.value.pageId !== "string" ||
          !sameId(projected.value.pageId, page.pageId) ||
          projected.value.applicationReleaseRevision !== installedContext.applicationReleaseRevision
        )
          return unavailable;

        const projectedAccessVersion =
          typeof projected.value.accessVersion === "number"
            ? projected.value.accessVersion
            : undefined;
        if (projectedAccessVersion === undefined) return unavailable;
        const finalIdentity = await humanOrganizationRequestsFor(dependencies).run(
          session,
          selection,
          async (transaction, scope) => {
            if (scope.applicationRootId === undefined)
              throw new Error("APPLICATION_SCOPE_UNAVAILABLE");
            const state = await createActiveInstallationBundleRepository(transaction).readCurrentState();
            return !state.repairNeeded &&
              state.identity.organizationId === scope.organizationId &&
              state.identity.organizationAccountId === scope.organizationAccountId &&
              state.identity.applicationRootId === scope.applicationRootId &&
              state.identity.accessVersion === scope.accessVersion &&
              state.identity.accessVersion === projectedAccessVersion &&
              state.identity.applicationReleaseRevision === installedContext.applicationReleaseRevision &&
              matchesInstalledPageBundleIdentity(installedContext, state);
          },
        );
        if (finalIdentity.kind !== "available" || !finalIdentity.value) return unavailable;

        // Hidden or unusable placements do not make a protected, openable Page unavailable.
        const result = applicationPageLinkResultSchema.safeParse({
          availability: "available",
          kind: selector.data.kind,
          organizationId: context.organizationId,
          applicationRootId: context.applicationRootId,
          applicationKey: application.definitionKey,
          pageId: identity.requested.pageId,
          pageKey: identity.requested.key,
          applicationReleaseRevision: installedContext.applicationReleaseRevision,
          releaseVersion: application.releaseVersion,
          contentFingerprint: application.contentFingerprint,
          resolutionFingerprint: application.resolutionFingerprint,
          label: selector.data.kind === "application" ? application.content.name : page.name,
          icon: application.content.icon,
          tenantShortName: read.tenantShortName,
          organizationShortName: read.organizationShortName,
        });
        return result.success ? result.data : unavailable;
      } catch {
        return unavailable;
      }
    },
  });
};
