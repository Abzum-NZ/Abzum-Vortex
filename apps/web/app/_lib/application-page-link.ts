import "server-only";

import {
  readAddressedApplicationFromInstalledBundleAtAddress,
  requireInstalledRuntimeContext,
  resolveInstalledPageIdentity,
  resolvePermittedApplicationAddress,
} from "@vortex/platform/server";
import {
  applicationPageLinkResultSchema,
  applicationPageLinkSelectorSchema,
  builderKeySchema,
  sameId,
  type ApplicationPageLinkResult,
  type ApplicationPageLinkSelector,
  type IdentitySession,
} from "@vortex/platform/schema";
import { createStoredPageCapabilityService } from "@vortex/platform/server";
import { humanOrganizationRequestDependencies } from "./server-composition";
import { platformPermissionSource } from "./platform-permission-source";

const unavailable = Object.freeze({ availability: "unavailable" as const });

/** The server binds this address; a browser selector cannot choose another organization. */
type ApplicationPageLinkAddress = Readonly<{
  tenantShortName: string;
  organizationShortName: string;
}>;

type AddressedRead = Awaited<
  ReturnType<typeof readAddressedApplicationFromInstalledBundleAtAddress>
>;
type AddressedApplication = Readonly<{
  read: Extract<AddressedRead["read"], { kind: "available" }>;
  context: NonNullable<AddressedRead["context"]>;
  identity: NonNullable<AddressedRead["identity"]>;
}>;
type PageProjection = ReturnType<ReturnType<typeof createStoredPageCapabilityService>["project"]>;

/**
 * Each read proves one current target under the signed person's own authority. The detached
 * result is a point-in-time candidate, not an atomic snapshot or permission to activate later.
 * A set of selectors reads each addressed application once and projects each distinct page once,
 * however many selectors name them.
 */
export const createApplicationPageLinkReader = (address: ApplicationPageLinkAddress) => {
  const boundAddress = Object.freeze({
    tenantShortName: address.tenantShortName,
    organizationShortName: address.organizationShortName,
  });

  const readApplication = async (
    session: IdentitySession,
    applicationKey: string,
  ): Promise<AddressedApplication | undefined> => {
    const tenantShortName = builderKeySchema.safeParse(boundAddress.tenantShortName);
    const organizationShortName = builderKeySchema.safeParse(boundAddress.organizationShortName);
    if (!tenantShortName.success || !organizationShortName.success) return undefined;
    const dependencies = humanOrganizationRequestDependencies();
    const addressed = await readAddressedApplicationFromInstalledBundleAtAddress(
      platformPermissionSource,
      session,
      tenantShortName.data,
      organizationShortName.data,
      dependencies.identityAuthorityId,
      applicationKey,
    );
    const { read, context, identity } = addressed;
    if (
      read.kind !== "available" ||
      context === undefined ||
      identity === undefined ||
      read.organizationId !== identity.organizationId ||
      read.tenantShortName !== tenantShortName.data ||
      read.organizationShortName !== organizationShortName.data ||
      read.applications.length !== 1
    )
      return undefined;
    return { read, context, identity };
  };

  const readSelector = async (
    session: IdentitySession,
    selector: ApplicationPageLinkSelector,
    addressed: AddressedApplication,
    projections: Map<string, PageProjection>,
  ): Promise<ApplicationPageLinkResult> => {
    const dependencies = humanOrganizationRequestDependencies();
    const { read, context, identity: addressedIdentity } = addressed;
    const target = resolvePermittedApplicationAddress(
      read,
      selector.applicationKey,
      selector.kind === "page" ? selector.pageKey : undefined,
    );
    if (
      target.kind !== "available" ||
      target.application === null ||
      target.pageKey === null ||
      target.application.key !== selector.applicationKey ||
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
      application.definitionKey !== selector.applicationKey ||
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

    // One projection per page: an application link and a page link to the same page share it.
    const projectionKey = String(page.pageId).toLowerCase();
    let pending = projections.get(projectionKey);
    if (pending === undefined) {
      pending = createStoredPageCapabilityService({
        ...dependencies,
        context: installedContext,
        selection: { pageId: page.pageId },
        permissions: platformPermissionSource,
      }).project(session, selection);
      projections.set(projectionKey, pending);
    }
    const projected = await pending;
    if (
      projected.kind !== "available" ||
      projected.value === undefined ||
      typeof projected.value.pageId !== "string" ||
      !sameId(projected.value.pageId, page.pageId) ||
      projected.value.applicationReleaseRevision !== installedContext.applicationReleaseRevision
    )
      return unavailable;

    // Hidden or unusable placements do not make a protected, openable Page unavailable.
    const result = applicationPageLinkResultSchema.safeParse({
      availability: "available",
      kind: selector.kind,
      organizationId: context.organizationId,
      applicationRootId: context.applicationRootId,
      applicationKey: application.definitionKey,
      pageId: identity.requested.pageId,
      pageKey: identity.requested.key,
      applicationReleaseRevision: installedContext.applicationReleaseRevision,
      releaseVersion: application.releaseVersion,
      contentFingerprint: application.contentFingerprint,
      resolutionFingerprint: application.resolutionFingerprint,
      label: selector.kind === "application" ? application.content.name : page.name,
      icon: application.content.icon,
      tenantShortName: read.tenantShortName,
      organizationShortName: read.organizationShortName,
    });
    if (!result.success)
      throw new Error("APPLICATION_PAGE_LINK_PROJECTION_INVALID", { cause: result.error });
    return result.data;
  };

  const readMany = async (
    session: IdentitySession,
    candidates: readonly unknown[],
  ): Promise<readonly ApplicationPageLinkResult[]> => {
    try {
      const results = new Array<ApplicationPageLinkResult>(candidates.length).fill(unavailable);
      const byApplication = new Map<
        string,
        { index: number; selector: ApplicationPageLinkSelector }[]
      >();
      for (const [index, candidate] of candidates.entries()) {
        const selector = applicationPageLinkSelectorSchema.safeParse(candidate);
        if (!selector.success) continue;
        const group = byApplication.get(selector.data.applicationKey) ?? [];
        group.push({ index, selector: selector.data });
        byApplication.set(selector.data.applicationKey, group);
      }
      const projections = new Map<string, PageProjection>();
      await Promise.all(
        [...byApplication].map(async ([applicationKey, group]) => {
          const addressed = await readApplication(session, applicationKey);
          if (addressed === undefined) return;
          await Promise.all(
            group.map(async ({ index, selector }) => {
              results[index] = await readSelector(session, selector, addressed, projections);
            }),
          );
        }),
      );
      return Object.freeze(results);
    } catch (error) {
      throw new Error("APPLICATION_PAGE_LINK_TARGET_READ_FAILED", { cause: error });
    }
  };

  return Object.freeze({
    readMany,
    async read(session: IdentitySession, candidate: unknown): Promise<ApplicationPageLinkResult> {
      return (await readMany(session, [candidate]))[0] ?? unavailable;
    },
  });
};
