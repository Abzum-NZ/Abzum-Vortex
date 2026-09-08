import "server-only";

import {
  applicationRootIdSchema,
  pageIdSchema,
  revisionSchema,
  sessionContextSchema,
  type IdentitySession,
  type ApplicationRootId,
  type OrganizationAccessDeclaration,
  type OrganizationSelectionCandidate,
  type PermissionRegistryEntryCandidate,
  type SessionContext,
} from "@vortex/contracts";
import {
  createPermissionRegistryDefinitionAdapter,
  type HumanOrganizationRequestDependencies,
} from "@vortex/access";
import {
  createDatabaseDefinitionConsumerReadService,
  type ImmutableDefinitionPublicationCatalogueDefinition,
} from "@vortex/definition";
import { withResolvedRequestTransaction } from "@vortex/db";
import {
  createAuthenticatedPageCapabilityService,
  type FixedAuthenticatedPageCapability,
} from "./authenticated-page-capability";

export type StoredV1PageCapabilitySelection = Readonly<{
  applicationRootId: string;
  releaseRevision: number;
  pageId: string;
}>;

export type StoredV1PageCapabilityDependencies = HumanOrganizationRequestDependencies &
  Readonly<{
    systemContext: SessionContext;
    selection: StoredV1PageCapabilitySelection;
    definitionCatalogue: ImmutableDefinitionPublicationCatalogueDefinition;
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

export const createStoredV1PageCapabilityService = (
  dependencies: StoredV1PageCapabilityDependencies,
) => {
  const systemContext = sessionContextSchema.parse(dependencies.systemContext);
  if (systemContext.callerKind !== "system")
    throw new Error("STORED_PAGE_SYSTEM_CONTEXT_UNAVAILABLE");
  const applicationRootId = applicationRootIdSchema.parse(dependencies.selection.applicationRootId);
  const releaseRevision = revisionSchema
    .max(Number.MAX_SAFE_INTEGER)
    .parse(dependencies.selection.releaseRevision);
  const selectedPageId = pageIdSchema.parse(dependencies.selection.pageId);
  if (
    systemContext.applicationRootId !== undefined &&
    !sameUuid(systemContext.applicationRootId, applicationRootId)
  )
    throw new Error("STORED_PAGE_SYSTEM_CONTEXT_UNAVAILABLE");
  const runResolved = dependencies.resolvedRequestTransaction ?? withResolvedRequestTransaction;

  const load = async (): Promise<FixedAuthenticatedPageCapability> =>
    runResolved(
      async () => ({ context: systemContext, scope: undefined }),
      async (transaction) => {
        const reader = createDatabaseDefinitionConsumerReadService(
          dependencies.definitionCatalogue,
          transaction,
        );
        const definitionAdapter = createPermissionRegistryDefinitionAdapter(reader);
        const registration = await definitionAdapter.prepareApplicationRegistration(systemContext, {
          applicationRootId,
          releaseRevision,
        });
        const release = await reader.read(systemContext, {
          kind: "application",
          rootId: applicationRootId,
          selector: { selection: "revision", releaseRevision },
        });
        if (
          release.kind !== "application" ||
          !sameUuid(release.organizationId, systemContext.organizationId) ||
          !sameUuid(release.rootId, applicationRootId) ||
          release.releaseRevision !== releaseRevision ||
          release.correlationId.toLowerCase() !== systemContext.correlationId.toLowerCase() ||
          registration.organizationId !== release.organizationId ||
          !sameUuid(registration.applicationRootId, release.rootId) ||
          registration.applicationRelease.definitionKey !== release.definitionKey ||
          registration.applicationRelease.releaseRevision !== release.releaseRevision ||
          registration.applicationRelease.releaseVersion !== release.releaseVersion ||
          registration.applicationRelease.validationContractVersion !==
            release.validationContractVersion ||
          registration.applicationRelease.contentFingerprint !== release.contentFingerprint ||
          registration.applicationRelease.resolutionFingerprint !== release.resolutionFingerprint
        )
          throw new Error("STORED_PAGE_DEFINITION_EVIDENCE_UNAVAILABLE");
        const pages = release.content.pages.filter((page) => sameUuid(page.pageId, selectedPageId));
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
        const placements =
          page.type === "guided_form"
            ? page.steps.flatMap((step) => step.blocks)
            : "blocks" in page
              ? page.blocks
              : [];
        return {
          page,
          sourceCorrelationId: release.correlationId,
          pagePermission: {
            permissionKey: page.accessPermissionKey,
            declaration: declaration("application.page.discover", applicationRootId, pageEntry),
          },
          placements: Object.fromEntries(
            placements.map((placement) => {
              const viewEntry = permission(placement.viewPermissionKey);
              const useEntry =
                placement.usePermissionKey === undefined
                  ? undefined
                  : permission(placement.usePermissionKey);
              return [
                placement.placementId,
                {
                  viewPermission: {
                    permissionKey: placement.viewPermissionKey,
                    declaration: declaration(
                      "application.page.placement.view",
                      applicationRootId,
                      viewEntry,
                    ),
                  },
                  ...(useEntry === undefined || placement.usePermissionKey === undefined
                    ? {}
                    : {
                        usePermission: {
                          permissionKey: placement.usePermissionKey,
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
      },
    );

  return Object.freeze({
    async project(session: IdentitySession, candidate: OrganizationSelectionCandidate) {
      if (
        !sameUuid(candidate.organizationId, systemContext.organizationId) ||
        candidate.applicationRootId === undefined ||
        !sameUuid(candidate.applicationRootId, applicationRootId)
      )
        return { kind: "unavailable" as const };
      const fixed = await load();
      return createAuthenticatedPageCapabilityService({
        ...dependencies,
        correlationId: () => systemContext.correlationId,
        adapter: {
          load: async (_transaction, scope) => {
            if (
              scope.applicationRootId === undefined ||
              !sameUuid(scope.organizationId, systemContext.organizationId) ||
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
