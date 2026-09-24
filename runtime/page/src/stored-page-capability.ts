import "server-only";

import {
  applicationRootIdSchema,
  pageIdSchema,
  revisionSchema,
  type IdentitySession,
  type ApplicationRootId,
  type OrganizationAccessDeclaration,
  type OrganizationSelectionCandidate,
  type PermissionRegistryEntryCandidate,
} from "@vortex/contracts";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "@vortex/access";
import { requireInstalledRuntimeContext, type InstalledRuntimeContext } from "@vortex/app";
import {
  createAuthenticatedPageCapabilityService,
  type FixedAuthenticatedPageCapability,
} from "./authenticated-page-capability";
import type { ProjectedPageCapability } from "./page-capability-projection";
import { resolvePageComposition } from "./page-composition-resolution";

/** The browser address may select only a page; organisation, installation and release come from context. */
export type StoredPageCapabilitySelection = Readonly<{
  pageId: string;
}>;

export type StoredPageCapabilityDependencies = HumanOrganizationRequestDependencies &
  Readonly<{
    /**
     * The single trusted installed context assembled by App. Page projects only from this exact
     * release set and never re-reads or rebuilds organisation, release or permission authority.
     */
    context: InstalledRuntimeContext;
    selection: StoredPageCapabilitySelection;
  }>;

const sameUuid = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const declaration = (
  operationKey: string,
  applicationRootId: ApplicationRootId,
  entry: PermissionRegistryEntryCandidate,
): OrganizationAccessDeclaration => ({
  operationKey,
  action: {
    actionKind: entry.permission.actionKind,
    ...(entry.permission.namedAction === undefined
      ? {}
      : { namedAction: entry.permission.namedAction }),
  },
  target: { kind: "application", applicationRootId },
  requiredPermission: {
    applicationRootId: entry.applicationRootId,
    ownerKind: entry.ownerKind,
    ownerId: entry.ownerId,
    permissionId: entry.permission.permissionId,
  },
  recentAuthentication: { kind: "none" },
  authority: { kind: "permission" },
});

const v2Placements = (slot: unknown): Record<string, unknown>[] => {
  const candidate = slot as { placements: Record<string, Record<string, unknown>> };
  return Object.entries(candidate.placements).flatMap(([placementId, placement]) => [
    { placementId, ...placement },
    ...Object.values(placement.slots as Record<string, unknown>).flatMap(v2Placements),
  ]);
};

export const createStoredPageCapabilityService = (
  dependencies: StoredPageCapabilityDependencies,
) => {
  // Only a context App assembled is accepted; a missing or look-alike object fails closed here.
  const context = requireInstalledRuntimeContext(dependencies.context);
  const applicationRootId = applicationRootIdSchema.parse(context.applicationRootId);
  const releaseRevision = revisionSchema
    .max(Number.MAX_SAFE_INTEGER)
    .parse(context.applicationReleaseRevision);
  const selectedPageId = pageIdSchema.parse(dependencies.selection.pageId);

  // The loader has already verified this; Page still refuses, rather than projects, a context
  // whose exact release, registration and scope disagree.
  const applicationRelease = context.releaseSet.application;
  const registration = context.permissionRegistration;
  if (
    applicationRelease.organizationId !== context.organizationId ||
    applicationRelease.rootId !== context.applicationRootId ||
    applicationRelease.releaseRevision !== releaseRevision ||
    registration.organizationId !== context.organizationId ||
    registration.applicationRootId !== context.applicationRootId ||
    registration.applicationRelease.releaseRevision !== releaseRevision
  )
    throw new Error("STORED_PAGE_TRUSTED_CONTEXT_UNAVAILABLE");

  const requestDependencies = {
    ...dependencies,
    correlationId: () => context.correlationId,
  };
  const requests = createHumanOrganizationRequestService(requestDependencies);

  // Undefined means the selected page is not in the release: a lasting answer, not a fault.
  const load = async (): Promise<FixedAuthenticatedPageCapability | undefined> => {
    const pages = applicationRelease.content.pages.filter((page) =>
      sameUuid(page.pageId, selectedPageId),
    );
    if (pages.length === 0) return undefined;
    if (pages.length !== 1 || pages[0] === undefined)
      throw new Error("STORED_PAGE_DEFINITION_EVIDENCE_UNAVAILABLE");
    const page = pages[0];
    const permission = (key: string) => {
      const matches = registration.entries.filter((entry) => entry.permission.key === key);
      if (matches.length !== 1 || matches[0] === undefined)
        throw new Error("STORED_PAGE_PERMISSION_BINDING_UNAVAILABLE");
      return matches[0];
    };
    const pageEntry = permission(page.accessPermissionKey);
    const resolved = resolvePageComposition(page, applicationRelease.content.shells);
    const placements: Record<string, unknown>[] =
      resolved.roots.kind === "page"
        ? v2Placements(resolved.roots.main)
        : Object.values(resolved.roots.stepContent).flatMap(v2Placements);
    return {
      page,
      applicationShells: applicationRelease.content.shells,
      sourceCorrelationId: applicationRelease.correlationId,
      pagePermission: {
        permissionKey: page.accessPermissionKey,
        declaration: declaration("application.page.discover", applicationRootId, pageEntry),
      },
      placements: Object.fromEntries(
        placements.map((placement) => {
          const placementId = String(placement.placementId);
          const viewPermissionKey = placement.viewPermissionKey as string | undefined;
          const usePermissionKey = placement.usePermissionKey as string | undefined;
          const viewEntry =
            viewPermissionKey === undefined ? undefined : permission(viewPermissionKey);
          const useEntry =
            usePermissionKey === undefined ? undefined : permission(usePermissionKey);
          return [
            placementId,
            {
              ...(viewEntry === undefined || viewPermissionKey === undefined
                ? {}
                : {
                    viewPermission: {
                      permissionKey: viewPermissionKey,
                      declaration: declaration(
                        "application.page.placement.view",
                        applicationRootId,
                        viewEntry,
                      ),
                    },
                  }),
              ...(useEntry === undefined || usePermissionKey === undefined
                ? {}
                : {
                    usePermission: {
                      permissionKey: usePermissionKey,
                      declaration: declaration(
                        "application.page.placement.use",
                        applicationRootId,
                        useEntry,
                      ),
                    },
                  }),
              operationBound: false,
            },
          ];
        }),
      ),
    };
  };

  return Object.freeze({
    async project(
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
    ): Promise<HumanOrganizationRequestResult<ProjectedPageCapability>> {
      if (
        !sameUuid(candidate.organizationId, context.organizationId) ||
        candidate.applicationRootId === undefined ||
        !sameUuid(candidate.applicationRootId, applicationRootId)
      )
        return { kind: "unavailable" };
      // Verify the session and application scope before projecting, so a caller without access
      // gets the same answer whether or not the page exists. The context read is already done by
      // App; the human request only proves the person's current authority over this scope.
      const verified = await requests.run(session, candidate, async () => undefined);
      if (verified.kind !== "available") return verified;
      let fixed: FixedAuthenticatedPageCapability | undefined;
      try {
        fixed = await load();
      } catch {
        return { kind: "temporarily_unavailable" };
      }
      if (fixed === undefined) return { kind: "unavailable" };
      const stored = fixed;
      return createAuthenticatedPageCapabilityService({
        ...requestDependencies,
        adapter: {
          load: async (_transaction, scope) => {
            if (
              scope.applicationRootId === undefined ||
              !sameUuid(scope.organizationId, context.organizationId) ||
              !sameUuid(scope.applicationRootId, applicationRootId)
            )
              throw new Error("STORED_PAGE_HUMAN_SCOPE_UNAVAILABLE");
            return stored;
          },
        },
      }).project(session, candidate, undefined);
    },
  });
};
