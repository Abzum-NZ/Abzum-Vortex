import "server-only";

import {
  sameId,
  viewerSafeRecordLinkIdentitySchema,
  viewerSafeRecordLinkResultSchema,
  type IdentitySession,
  type OrganizationSelectionCandidate,
  type SelectedOrganizationScope,
  type ViewerSafeRecordLinkResult,
} from "@vortex/contracts";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
} from "@vortex/access";
import type { RequestDatabaseTransaction } from "@vortex/db";
import {
  createViewerSafeRecordLinkReadService,
  type ViewerSafeRecordLinkTitleReadResult,
} from "@vortex/query";
import {
  requireInstalledRuntimeContext,
  type InstalledRuntimeContext,
  type InstalledRuntimeContextLoader,
} from "./installed-runtime-context";

export type ViewerSafeRecordLinkInstalledContextLoaderFactory = (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
) => InstalledRuntimeContextLoader;

export type ViewerSafeRecordLinkServiceDependencies = HumanOrganizationRequestDependencies &
  Readonly<{
    /** Compose the existing human installed-context loader for this request transaction and scope. */
    createInstalledContextLoader: ViewerSafeRecordLinkInstalledContextLoaderFactory;
  }>;

const unavailable: ViewerSafeRecordLinkResult = { outcome: "unavailable" };

const matchingRecordType = (
  context: InstalledRuntimeContext,
  identity: ReturnType<typeof viewerSafeRecordLinkIdentitySchema.parse>,
) => {
  const modules = context.releaseSet.modules.filter(
    (module) =>
      sameId(module.rootId, identity.moduleRootId) &&
      module.releaseRevision === identity.moduleReleaseRevision,
  );
  if (modules.length !== 1 || modules[0] === undefined) return undefined;
  const recordTypes = modules[0].content.recordTypes.filter(
    (recordType) =>
      sameId(recordType.recordTypeId, identity.recordTypeId) &&
      sameId(recordType.storageContractId, identity.storageContractId),
  );
  return recordTypes.length === 1 ? recordTypes[0] : undefined;
};

const matchingDetailPage = (
  context: InstalledRuntimeContext,
  identity: ReturnType<typeof viewerSafeRecordLinkIdentitySchema.parse>,
) => {
  const pages = context.releaseSet.application.content.pages.filter(
    (page) =>
      page.type === "detail" &&
      page.recordType.state === "resolved" &&
      sameId(page.recordType.moduleRootId, identity.moduleRootId) &&
      sameId(page.recordType.recordTypeId, identity.recordTypeId),
  );
  return pages.length === 1 ? pages[0] : undefined;
};

const currentContextMatches = (
  context: InstalledRuntimeContext,
  identity: ReturnType<typeof viewerSafeRecordLinkIdentitySchema.parse>,
): boolean =>
  sameId(context.organizationId, identity.organizationId) &&
  sameId(context.applicationRootId, identity.applicationRootId) &&
  sameId(context.installation.organizationId, identity.organizationId) &&
  sameId(context.installation.applicationRootId, identity.applicationRootId) &&
  context.applicationReleaseRevision === context.installation.applicationReleaseRevision;

const completeRead = (
  context: InstalledRuntimeContext,
  identity: ReturnType<typeof viewerSafeRecordLinkIdentitySchema.parse>,
  page: NonNullable<ReturnType<typeof matchingDetailPage>>,
  readTitle: ViewerSafeRecordLinkTitleReadResult,
): ViewerSafeRecordLinkResult => {
  if (readTitle.outcome !== "read") return unavailable;
  return viewerSafeRecordLinkResultSchema.parse({
    outcome: "available",
    title: readTitle.title,
    detailAddress: {
      applicationRootId: context.applicationRootId,
      applicationKey: context.releaseSet.application.definitionKey,
      pageId: page.pageId,
      pageKey: page.key,
      recordId: identity.recordId,
    },
  });
};

/**
 * Resolves one exact installed target record for the current human viewer. The identity tuple only
 * selects the target context: App verifies the active installation and exact bound releases, then
 * Query obtains the title through the current protected Record read. Detail-page access is checked
 * again by its destination; this link read discloses no page content beyond its route identity.
 */
export const createViewerSafeRecordLinkService = (
  dependencies: ViewerSafeRecordLinkServiceDependencies,
) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const records = createViewerSafeRecordLinkReadService();

  return Object.freeze({
    async read(
      session: IdentitySession,
      identityCandidate: unknown,
    ): Promise<ViewerSafeRecordLinkResult> {
      const identity = viewerSafeRecordLinkIdentitySchema.safeParse(identityCandidate);
      if (!identity.success) return unavailable;

      const selection: OrganizationSelectionCandidate = {
        organizationId: identity.data.organizationId,
        applicationRootId: identity.data.applicationRootId,
      };
      try {
        const request = await requests.run(
          session,
          selection,
          async (transaction, scope): Promise<ViewerSafeRecordLinkResult> => {
            if (
              !sameId(scope.organizationId, identity.data.organizationId) ||
              scope.applicationRootId === undefined ||
              !sameId(scope.applicationRootId, identity.data.applicationRootId)
            )
              return unavailable;

            const context = requireInstalledRuntimeContext(
              await dependencies.createInstalledContextLoader(transaction, scope).load(),
            );
            if (!currentContextMatches(context, identity.data)) return unavailable;
            const recordType = matchingRecordType(context, identity.data);
            const page = matchingDetailPage(context, identity.data);
            if (recordType === undefined || page === undefined) return unavailable;

            const titleRead = await records.read(transaction, scope, {
              identity: identity.data,
              applicationReleaseRevision: context.applicationReleaseRevision,
              titleFieldId: recordType.titleFieldId,
            });
            return completeRead(context, identity.data, page, titleRead);
          },
        );
        return request.kind === "available"
          ? viewerSafeRecordLinkResultSchema.parse(request.value)
          : unavailable;
      } catch {
        return unavailable;
      }
    },
  });
};

export type ViewerSafeRecordLinkService = ReturnType<typeof createViewerSafeRecordLinkService>;
