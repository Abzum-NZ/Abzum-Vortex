import "server-only";

import {
  applicationDefinitionConsumerReadResultV1Schema,
  applicationDefinitionConsumerReadResultV2Schema,
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
  createStoredApplicationPermissionSource,
  type HumanOrganizationRequestDependencies,
  type StoredApplicationPermissionSourceDependencies,
} from "@vortex/access";
import {
  createAuthenticatedPageCapabilityService,
  type FixedAuthenticatedPageCapability,
} from "./authenticated-page-capability";
import { resolvePageComposition } from "./page-composition-resolution";

export type StoredPageCapabilitySelection = Readonly<{
  applicationRootId: string;
  releaseRevision: number;
  pageId: string;
}>;

export type StoredPageCapabilityDependencies = HumanOrganizationRequestDependencies &
  Omit<StoredApplicationPermissionSourceDependencies, "applicationRootId" | "releaseRevision"> &
  Readonly<{ selection: StoredPageCapabilitySelection }>;

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
  const applicationRootId = applicationRootIdSchema.parse(dependencies.selection.applicationRootId);
  const releaseRevision = revisionSchema
    .max(Number.MAX_SAFE_INTEGER)
    .parse(dependencies.selection.releaseRevision);
  const selectedPageId = pageIdSchema.parse(dependencies.selection.pageId);
  const source = createStoredApplicationPermissionSource({
    systemContext: dependencies.systemContext,
    applicationRootId,
    releaseRevision,
    definitionCatalogue: dependencies.definitionCatalogue,
    ...(dependencies.resolvedRequestTransaction === undefined
      ? {}
      : { resolvedRequestTransaction: dependencies.resolvedRequestTransaction }),
  });

  const load = async (): Promise<FixedAuthenticatedPageCapability> =>
    source
      .readExact()
      .then(({ applicationRelease: release, permissionRegistration: registration }) => {
        const parsedV2 = applicationDefinitionConsumerReadResultV2Schema.safeParse(release);
        const parsedV1 = applicationDefinitionConsumerReadResultV1Schema.safeParse(release);
        if (!parsedV2.success && !parsedV1.success)
          throw new Error("STORED_PAGE_DEFINITION_EVIDENCE_UNAVAILABLE");
        const applicationRelease = parsedV2.success ? parsedV2.data : parsedV1.data!;
        const pages = applicationRelease.content.pages.filter((page) =>
          sameUuid(page.pageId, selectedPageId),
        );
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
        const resolved = resolvePageComposition(
          page,
          parsedV2.success ? parsedV2.data.content.shells : [],
        );
        const placements: Record<string, unknown>[] =
          resolved.version === "1"
            ? resolved.page.type === "guided_form"
              ? resolved.page.steps.flatMap((step) => step.blocks)
              : "blocks" in resolved.page
                ? resolved.page.blocks
                : []
            : resolved.roots.kind === "page"
              ? v2Placements(resolved.roots.main)
              : Object.values(resolved.roots.stepContent).flatMap(v2Placements);
        return {
          page,
          ...(parsedV2.success ? { applicationShells: parsedV2.data.content.shells } : {}),
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
      });

  return Object.freeze({
    async project(session: IdentitySession, candidate: OrganizationSelectionCandidate) {
      if (
        !sameUuid(candidate.organizationId, dependencies.systemContext.organizationId) ||
        candidate.applicationRootId === undefined ||
        !sameUuid(candidate.applicationRootId, applicationRootId)
      )
        return { kind: "unavailable" as const };
      const fixed = await load();
      return createAuthenticatedPageCapabilityService({
        ...dependencies,
        correlationId: () => dependencies.systemContext.correlationId,
        adapter: {
          load: async (_transaction, scope) => {
            if (
              scope.applicationRootId === undefined ||
              !sameUuid(scope.organizationId, dependencies.systemContext.organizationId) ||
              !sameUuid(scope.applicationRootId, applicationRootId)
            )
              throw new Error("STORED_PAGE_HUMAN_SCOPE_UNAVAILABLE");
            return fixed;
          },
        },
      }).project(session, candidate, undefined);
    },
  });
};
