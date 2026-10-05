import "server-only";

import {
  createHumanInstalledRuntimeContextLoader,
  readAddressedApplicationAtAddress,
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
import { createActiveApplicationInstallationRepository } from "@vortex/module";
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
        const { read } = await readAddressedApplicationAtAddress(
          session,
          tenantShortName.data,
          organizationShortName.data,
          dependencies.identityAuthorityId,
          selector.data.applicationKey,
        );
        if (
          read.kind !== "available" ||
          read.tenantShortName !== tenantShortName.data ||
          read.organizationShortName !== organizationShortName.data ||
          read.applications.length !== 1
        )
          return unavailable;

        const target = resolvePermittedApplicationAddress(
          read,
          selector.data.applicationKey,
          selector.data.kind === "page" ? selector.data.pageKey : undefined,
        );
        if (
          target.kind !== "available" ||
          target.application === null ||
          target.pageKey === null ||
          target.application.key !== selector.data.applicationKey
        )
          return unavailable;

        const permittedApplication = target.application;
        const selection = {
          organizationId: read.organizationId,
          applicationRootId: permittedApplication.applicationRootId,
        };
        const loaded = await humanOrganizationRequestsFor(dependencies).run(
          session,
          selection,
          async (transaction, scope) => {
            if (scope.applicationRootId === undefined)
              throw new Error("APPLICATION_SCOPE_UNAVAILABLE");
            return createHumanInstalledRuntimeContextLoader({
              activeInstallationReader: createActiveApplicationInstallationRepository(transaction),
              releaseSetReader: createDatabaseApplicationBoundReleaseSetService(
                installedReleaseCatalogue,
                transaction,
              ),
              scope: {
                organizationId: scope.organizationId,
                applicationRootId: scope.applicationRootId,
              },
            }).load();
          },
        );
        if (loaded.kind !== "available") return unavailable;

        const context = requireInstalledRuntimeContext(loaded.value);
        const application = context.releaseSet.application;
        if (
          !sameId(context.organizationId, read.organizationId) ||
          !sameId(context.applicationRootId, permittedApplication.applicationRootId) ||
          !sameId(application.organizationId, context.organizationId) ||
          !sameId(application.rootId, context.applicationRootId) ||
          application.definitionKey !== selector.data.applicationKey ||
          application.releaseRevision !== context.applicationReleaseRevision ||
          application.content.name !== permittedApplication.name ||
          application.content.icon !== permittedApplication.icon
        )
          return unavailable;

        const pages = application.content.pages.filter((page) => page.key === target.pageKey);
        if (pages.length !== 1) return unavailable;
        const page = pages[0];
        if (page === undefined) return unavailable;
        const identity = resolveInstalledPageIdentity(context, { pageId: page.pageId });
        if (
          identity === undefined ||
          !sameId(identity.organizationId, context.organizationId) ||
          !sameId(identity.applicationRootId, context.applicationRootId) ||
          !sameId(identity.requested.pageId, page.pageId) ||
          identity.requested.key !== page.key ||
          identity.applicationReleaseRevision !== context.applicationReleaseRevision ||
          identity.releaseVersion !== application.releaseVersion ||
          identity.contentFingerprint !== application.contentFingerprint ||
          identity.resolutionFingerprint !== application.resolutionFingerprint
        )
          return unavailable;

        const projected = await createStoredPageCapabilityService({
          ...dependencies,
          context,
          selection: { pageId: page.pageId },
        }).project(session, selection);
        if (
          projected.kind !== "available" ||
          projected.value === undefined ||
          typeof projected.value.pageId !== "string" ||
          !sameId(projected.value.pageId, page.pageId) ||
          projected.value.applicationReleaseRevision !== context.applicationReleaseRevision
        )
          return unavailable;

        // Hidden or unusable placements do not make a protected, openable Page unavailable.
        const result = applicationPageLinkResultSchema.safeParse({
          availability: "available",
          kind: selector.data.kind,
          organizationId: context.organizationId,
          applicationRootId: context.applicationRootId,
          applicationKey: application.definitionKey,
          pageId: identity.requested.pageId,
          pageKey: identity.requested.key,
          applicationReleaseRevision: context.applicationReleaseRevision,
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
