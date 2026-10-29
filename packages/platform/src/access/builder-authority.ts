import type { PlatformPermissionSource } from "./platform-permissions";
import "server-only";

import { unavailableError } from "../catalogue/runtime-primitives";
import type { SelectedOrganizationScope } from "./identity-access";
import {
  organizationAccessDeclarationSchema,
  type OrganizationAccessDeclaration,
} from "./organization-access-decision";
import {
  builderRecentAuthentication,
  deriveBuilderRequirements,
  roleAcceptanceAuthentication,
  type BuilderAuthority,
  type BuilderAuthorityDecision,
  type BuilderConferredPermission,
  type BuilderOperation,
  type BuilderPermissionKey,
  type BuilderTargetFacts,
} from "../definition/builder-authority";
import type { RequestDatabaseTransaction } from "../db/request-transaction";
import { runOrganizationAccessOperation } from "./organization-access-decision-access";

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

/** The persisted origin of an Application root. */
export type BuilderApplicationOrigin = "ordinary" | "platform_system_application";

/**
 * The one read of an Application root's classification in the request's own organisation:
 * undefined when the root is missing, foreign or not an Application. Any other database answer
 * is a defect and throws.
 */
export const readBuilderApplicationOrigin = async (
  transaction: RequestDatabaseTransaction,
  rootId: string,
): Promise<BuilderApplicationOrigin | undefined> => {
  const rows = await transaction.query<{ outcome: unknown; application_origin_kind: unknown }>`
    select outcome, application_origin_kind
    from vortex_definition.read_builder_application_root_classification(${rootId}::uuid)
  `;
  const row = rows[0];
  if (rows.length === 1 && row?.outcome === "unavailable" && row.application_origin_kind === null)
    return undefined;
  if (
    rows.length !== 1 ||
    row?.outcome !== "available" ||
    (row.application_origin_kind !== "ordinary" &&
      row.application_origin_kind !== "platform_system_application")
  )
    throw new Error("BUILDER_APPLICATION_CLASSIFICATION_INVALID");
  return row.application_origin_kind;
};

const unavailableCode = "BUILDER_AUTHORITY_UNAVAILABLE";

export type BuilderAuthorityDependencies = Readonly<{
  transaction: RequestDatabaseTransaction;
  /** The selected organisation scope resolved for the authenticated human's own request. */
  scope: SelectedOrganizationScope;
  targetFacts: BuilderTargetFactsReader;
  /** The shipped platform permission catalogue the authority's declarations are built from. */
  permissions: PlatformPermissionSource;
}>;

/** The exact permission identity is looked up in the platform catalogue, never taken as input. */
const declarationForPermission = (
  permissions: PlatformPermissionSource,
  key: BuilderPermissionKey,
): OrganizationAccessDeclaration => {
  const permission = permissions.declarations.find((entry) => entry.key === key);
  if (permission === undefined) throw unavailableError(unavailableCode);
  return organizationAccessDeclarationSchema.parse({
    operationKey: permission.key,
    action: { actionKind: permission.actionKind },
    target: { kind: "organization" },
    requiredPermission: {
      ownerKind: "platform",
      ownerId: permissions.ownerId,
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
  catalogue: PlatformPermissionSource,
  permissions: readonly BuilderConferredPermission[],
): OrganizationAccessDeclaration => {
  const applications = catalogue.declarations.find(
    (entry) => entry.key === "platform.organization.applications.manage",
  );
  if (applications === undefined) throw unavailableError(unavailableCode);
  return organizationAccessDeclarationSchema.parse({
    operationKey: "platform.organization.application_role_templates.accept",
    action: { actionKind: applications.actionKind },
    target: { kind: "organization" },
    requiredPermission: {
      ownerKind: "platform",
      ownerId: catalogue.ownerId,
      permissionId: applications.permissionId,
    },
    recentAuthentication: roleAcceptanceAuthentication,
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
 * builder operation runs. Human Application draft storage shares this exact transaction; existing
 * System lifecycle compositions keep their validated System storage path. A human authority cannot
 * evaluate a decision over a System-bound transaction, so a wrong composition fails closed.
 */
export const createBuilderAuthority = (
  dependencies: BuilderAuthorityDependencies,
): BuilderAuthority => ({
  organizationId: dependencies.scope.organizationId,

  async require(operation: BuilderOperation): Promise<BuilderAuthorityDecision> {
    const rootId =
      operation.kind === "installation" ? operation.applicationRootId : operation.rootId;
    const facts = await dependencies.targetFacts(
      dependencies.transaction,
      dependencies.scope,
      rootId,
    );
    const requirements = deriveBuilderRequirements(operation, facts);

    const declarations = requirements.permissionKeys.map((key) => {
      const declaration = declarationForPermission(dependencies.permissions, key);
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
      declarations.push(declarationForAcceptance(dependencies.permissions, delegated));

    for (const declaration of declarations) {
      const checked = await runOrganizationAccessOperation(
        dependencies.transaction,
        dependencies.scope,
        declaration,
        async (decision) => decision.correlationId,
      );
      if (checked.outcome !== "completed")
        return {
          outcome: "refused",
          reason:
            checked.reasonCode === "multi_factor_required"
              ? "multi_factor_required"
              : checked.reasonCode === "authentication_required"
                ? "authentication_required"
                : "permission_refused",
          correlationId: checked.correlationId,
        };
      // An operation refused whatever the actor holds (uninstalling a system application) is
      // refused under the trusted correlation of the first decision.
      if (requirements.refused)
        return { outcome: "refused", reason: "permission_refused", correlationId: checked.value };
    }
    if (requirements.refused || declarations.length === 0) throw unavailableError(unavailableCode);
    return { outcome: "allowed" };
  },
});
