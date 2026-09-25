import "server-only";

import {
  organizationAccessDeclarationSchema,
  type OrganizationAccessDeclaration,
  type SelectedOrganizationScope,
} from "@vortex/contracts";
import {
  builderRecentAuthentication,
  deriveBuilderRequirements,
  type BuilderAuthority,
  type BuilderAuthorityDecision,
  type BuilderConferredPermission,
  type BuilderOperation,
  type BuilderPermissionKey,
  type BuilderTargetFacts,
} from "@vortex/definition";
import type { RequestDatabaseTransaction } from "@vortex/db";
import { runOrganizationAccessOperation } from "./organization-access-decision";
import {
  platformPermissionCatalogue,
  platformPermissionCatalogueOwnerId,
} from "./platform-permission-catalogue";

/**
 * The trusted source of target facts. It is answered from server evidence about the exact root in
 * the caller's organisation, never from request input. There is no default: a composition root
 * must supply one, so a builder operation can never silently assume a root is not a system
 * application.
 */
export type BuilderTargetFactsReader = (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  rootId: string | undefined,
) => Promise<BuilderTargetFacts>;

export type BuilderAuthorityDependencies = Readonly<{
  transaction: RequestDatabaseTransaction;
  /** The selected organisation scope resolved for the authenticated human's own request. */
  scope: SelectedOrganizationScope;
  targetFacts: BuilderTargetFactsReader;
}>;

const unavailable = (): Error => new Error("BUILDER_AUTHORITY_UNAVAILABLE");

/** The exact permission identity is looked up in the platform catalogue, never taken as input. */
const declarationForPermission = (key: BuilderPermissionKey): OrganizationAccessDeclaration => {
  const permission = platformPermissionCatalogue.permissions.find((entry) => entry.key === key);
  if (permission === undefined) throw unavailable();
  return organizationAccessDeclarationSchema.parse({
    operationKey: permission.key,
    action: { actionKind: permission.actionKind },
    target: { kind: "organization" },
    requiredPermission: {
      ownerKind: "platform",
      ownerId: platformPermissionCatalogueOwnerId,
      permissionId: permission.permissionId,
    },
    recentAuthentication: { kind: "none" },
    authority: { kind: "permission" },
  });
};

/**
 * The declaration for accepting role templates: the installer holds the application-management
 * permission and every permission the templates confer lies inside the installer's delegated
 * assignment scope, whatever any approval workflow says.
 */
const declarationForAcceptance = (
  permissions: readonly BuilderConferredPermission[],
  recentAuthentication: boolean,
): OrganizationAccessDeclaration => {
  const applications = platformPermissionCatalogue.permissions.find(
    (entry) => entry.key === "platform.organization.applications.manage",
  );
  if (applications === undefined) throw unavailable();
  return organizationAccessDeclarationSchema.parse({
    operationKey: "platform.organization.application_role_templates.accept",
    action: { actionKind: applications.actionKind },
    target: { kind: "organization" },
    requiredPermission: {
      ownerKind: "platform",
      ownerId: platformPermissionCatalogueOwnerId,
      permissionId: applications.permissionId,
    },
    recentAuthentication: recentAuthentication ? builderRecentAuthentication : { kind: "none" },
    authority: {
      kind: "delegated_management",
      before: { kind: "none" },
      after: {
        kind: "bounded",
        permissions: permissions.map((permission) => ({
          applicationRootId: permission.applicationRootId.toLowerCase(),
          ownerKind: permission.ownerKind,
          ownerId: permission.ownerId.toLowerCase(),
          permissionId: permission.permissionId.toLowerCase(),
        })),
      },
    },
  });
};

const uniquePermissions = (
  permissions: readonly BuilderConferredPermission[],
): readonly BuilderConferredPermission[] => {
  const byIdentity = new Map<string, BuilderConferredPermission>();
  for (const permission of permissions)
    byIdentity.set(
      [
        permission.applicationRootId,
        permission.ownerKind,
        permission.ownerId,
        permission.permissionId,
      ]
        .join(":")
        .toLowerCase(),
      permission,
    );
  return [...byIdentity.values()];
};

/**
 * Builds the builder authority over the caller's own request transaction and selected scope. Every
 * required permission is decided by the same `runOrganizationAccessOperation` path the other
 * protected operations use, so permission, recent authentication and delegated scope are decided
 * by the database from trusted context. The first refusal is returned; any doubt throws.
 *
 * The transaction must be the authenticated human's own request transaction, still open when a
 * builder operation runs. Definition storage runs over a separate system-bound transaction; an
 * authority built over that one cannot evaluate a human decision and throws, so a wrong
 * composition fails closed rather than allowing the operation.
 */
export const createBuilderAuthority = (
  dependencies: BuilderAuthorityDependencies,
): BuilderAuthority => ({
  organizationId: dependencies.scope.organizationId,

  async require(operation: BuilderOperation): Promise<BuilderAuthorityDecision> {
    const rootId =
      operation.kind === "installation" ? operation.applicationRootId : operation.rootId;
    const facts = await dependencies.targetFacts(dependencies.transaction, dependencies.scope, rootId);
    const requirements = deriveBuilderRequirements(operation, facts);

    const declarations = requirements.permissionKeys.map((key) => {
      const declaration = declarationForPermission(key);
      // Recent authentication rides on the first declaration so it is decided once.
      return key === requirements.permissionKeys[0] && requirements.recentAuthentication
        ? organizationAccessDeclarationSchema.parse({
            ...declaration,
            recentAuthentication: builderRecentAuthentication,
          })
        : declaration;
    });
    const delegated = uniquePermissions(requirements.delegatedPermissions);
    if (delegated.length > 0)
      declarations.push(declarationForAcceptance(delegated, requirements.recentAuthentication));

    for (const declaration of declarations) {
      const checked = await runOrganizationAccessOperation(
        dependencies.transaction,
        dependencies.scope,
        declaration,
        async () => true,
      );
      if (checked.outcome !== "completed")
        return {
          outcome: "refused",
          reason:
            checked.reasonCode === "authentication_required"
              ? "authentication_required"
              : "permission_refused",
          correlationId: checked.correlationId,
        };
    }
    return { outcome: "allowed" };
  },
});
