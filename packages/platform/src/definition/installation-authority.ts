import "server-only";

import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";
import {
  BuilderAuthorityError,
  createBuilderAuthority,
  requireBuilderAuthority,
  runOrganizationAccessOperation,
  type BuilderAuthority,
  type BuilderConferredPermission,
  type BuilderOperation,
} from "../access/index";
import {
  LiveContextRefused,
  readLiveHumanContext,
  type LiveHumanContext,
} from "../access/live-context";
import type { PlatformPermissionSource } from "../access/platform-permissions";
import {
  databaseTimestamp,
  organizationAccessDeclarationSchema,
  organizationPermissionEligibilitySchema,
  projectLiveApplicationRolePermissions,
  sameId,
  timestampSchema,
  type IdentitySession,
  type OrganizationAccessDeclaration,
  type SelectedOrganizationScope,
} from "../schema";
import {
  builderPermissionKeys,
  builderRecentAuthentication,
  deriveBuilderRequirements,
} from "./builder-authority";
import type { prepareApplicationRoleTemplatesForHumanRequest } from "../access/application-role-template-adapter";

type InstallationProblemKind =
  "conflict" | "refused" | "authentication_required" | "temporarily_unavailable" | "failed";

export type InstallationUnavailableReason =
  | "republish_required"
  | "not_installed"
  | "not_newer"
  | "module_set_changed"
  | "storage_incompatible"
  | "installation_incomplete"
  | "registration_misaligned"
  | "unsupported_root";

/**
 * Why accepting the application's roles or the installer's member role choice was refused: a
 * missing permission or delegation, a member role that is retired or awaits acceptance, or access
 * that someone else changed at the same time.
 */
export type InstallationMemberRoleRefusal =
  | "installation_authority"
  | "member_role_delegation"
  | "assignments_manage"
  | "role_unavailable"
  | "access_changed";

export type InstallationProblemShape = Readonly<{
  kind: InstallationProblemKind;
  unavailableReason?: InstallationUnavailableReason;
  memberRoleRefusal?: InstallationMemberRoleRefusal;
}>;

/**
 * A refusal or failure of an installation check. `kind` and `unavailableReason` are what the
 * caller is shown; `code` names the exact check that failed because describeFailure logs the
 * class and code, never the message.
 */
export class InstallationProblem extends Error {
  readonly code: string;
  constructor(
    readonly problem: InstallationProblemShape,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`${problem.kind}: ${detail}`, options);
    this.name = "InstallationProblem";
    this.code = detail;
  }
}

export function installationProblem(
  detail: string,
  kind: InstallationProblemKind,
  unavailableReason?: InstallationUnavailableReason,
  options?: ErrorOptions,
): never {
  throw new InstallationProblem(
    { kind, ...(unavailableReason === undefined ? {} : { unavailableReason }) },
    detail,
    options,
  );
}

export type InstallationHumanContext = LiveHumanContext;

/** The database transaction's own clock as the timestamp the installation snapshots carry. */
export const readInstallationDatabaseTime = async (
  transaction: RequestDatabaseTransaction,
): Promise<string> => {
  const rows = await transaction.query<DatabaseRow>`
    select pg_catalog.clock_timestamp() as checked_at
  `;
  const parsed = timestampSchema.safeParse(databaseTimestamp(rows[0]?.checked_at));
  if (rows.length !== 1 || !parsed.success)
    installationProblem("database_clock_unreadable", "temporarily_unavailable", undefined, {
      cause: parsed.success ? undefined : parsed.error,
    });
  return parsed.data;
};

/**
 * Proves the open transaction's human context is this request's session and exactly the selected
 * scope the installation names (organisation only, or organisation plus application).
 */
export const readInstallationHumanContext = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
  issuedAt: string,
  expected: Readonly<{ organizationId: string; applicationRootId?: string }>,
): Promise<InstallationHumanContext> => {
  const appScopeMatches =
    expected.applicationRootId === undefined
      ? scope.applicationRootId === undefined
      : scope.applicationRootId !== undefined &&
        sameId(scope.applicationRootId, expected.applicationRootId);
  if (!appScopeMatches || !sameId(scope.organizationId, expected.organizationId))
    installationProblem("selected_scope_mismatch", "refused");
  try {
    return await readLiveHumanContext(transaction, { scope, session, issuedAt });
  } catch (error) {
    if (error instanceof LiveContextRefused)
      return installationProblem("human_context_refused", "refused", undefined, { cause: error });
    throw error;
  }
};

export const readInstallationOrdinaryRoot = async (
  transaction: RequestDatabaseTransaction,
  rootId: string,
): Promise<Readonly<{ isSystemApplication: false }>> => {
  const rows = await transaction.query<DatabaseRow>`
    select outcome, application_origin_kind
    from vortex_definition.read_builder_application_root_classification(${rootId}::uuid)
  `;
  if (rows.length !== 1 || rows[0]?.outcome !== "available")
    installationProblem("application_root_unavailable", "refused", "unsupported_root");
  if (rows[0]?.application_origin_kind !== "ordinary")
    installationProblem("application_root_not_ordinary", "refused", "unsupported_root");
  return { isSystemApplication: false };
};

/** The target facts of the Studio installation flows: only ordinary applications are installable. */
export const installationTargetFacts = async (
  transaction: RequestDatabaseTransaction,
  _scope: SelectedOrganizationScope,
  rootId: string | undefined,
) => {
  if (rootId === undefined)
    installationProblem("application_root_missing", "refused", "unsupported_root");
  return readInstallationOrdinaryRoot(transaction, rootId);
};

export const installationPermissionDeclaration = (
  permissions: PlatformPermissionSource,
  key: string,
  requiresRecentAuthentication = false,
): OrganizationAccessDeclaration => {
  const permission = permissions.declarations.find((entry) => entry.key === key);
  if (permission === undefined)
    installationProblem("permission_undeclared", "temporarily_unavailable");
  return organizationAccessDeclarationSchema.parse({
    operationKey: key,
    action: { actionKind: permission.actionKind },
    target: { kind: "organization" },
    requiredPermission: {
      ownerKind: "platform",
      ownerId: permissions.ownerId,
      permissionId: permission.permissionId,
    },
    recentAuthentication: requiresRecentAuthentication
      ? builderRecentAuthentication
      : { kind: "none" },
    authority: { kind: "permission" },
  });
};

const eligibleUntil = (decisionValue: unknown, context: InstallationHumanContext): string => {
  const parsed = organizationPermissionEligibilitySchema.safeParse({
    ...(decisionValue as object),
    outcome: "eligible",
  });
  if (!parsed.success || parsed.data.outcome !== "eligible")
    installationProblem("eligibility_unreadable", "refused", undefined, {
      cause: parsed.success ? undefined : parsed.error,
    });
  if (
    parsed.data.target.kind !== "organization" ||
    !sameId(parsed.data.organizationId, context.organizationId) ||
    !sameId(parsed.data.organizationAccountId, context.organizationAccountId) ||
    parsed.data.accessVersion !== context.accessVersion ||
    !sameId(parsed.data.correlationId, context.correlationId) ||
    Date.parse(parsed.data.checkedAt) > Date.parse(parsed.data.validUntil)
  )
    installationProblem("eligibility_context_mismatch", "refused");
  return parsed.data.validUntil;
};

export const readInstallationPermissionDeadline = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  context: InstallationHumanContext,
  permissions: PlatformPermissionSource,
  key: string,
  requiresRecentAuthentication = false,
): Promise<string> => {
  const decision = await runOrganizationAccessOperation(
    transaction,
    scope,
    installationPermissionDeclaration(permissions, key, requiresRecentAuthentication),
    async (allowed) => allowed,
  );
  if (decision.outcome !== "completed")
    installationProblem(
      `permission_${decision.reasonCode}`,
      decision.reasonCode === "authentication_required" ? "authentication_required" : "refused",
    );
  return eligibleUntil(decision.value, context);
};

export const requireInstallationAuthority = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  permissions: PlatformPermissionSource,
  operation: BuilderOperation,
): Promise<void> => {
  const authority = createBuilderAuthority({
    transaction,
    scope,
    targetFacts: installationTargetFacts,
    permissions,
  });
  await requireBuilderAuthority(authority, operation).catch((error: unknown) => {
    if (
      error instanceof Error &&
      "code" in error &&
      String((error as { readonly code?: unknown }).code) ===
        "BUILDER_RECENT_AUTHENTICATION_REQUIRED"
    )
      installationProblem("recent_authentication_required", "authentication_required", undefined, {
        cause: error,
      });
    return error instanceof BuilderAuthorityError &&
      error.code === "BUILDER_PERMISSION_REFUSED" &&
      operation.kind === "installation"
      ? refuseWithoutManage(authority, operation.applicationRootId, error)
      : installationProblem("builder_authority_refused", "refused", undefined, { cause: error });
  });
};

/**
 * The refusal does not say which requirement failed, so Manage applications alone is asked again:
 * only its absence is named; another requirement (custom code, a system application) stays untyped.
 */
const refuseWithoutManage = async (
  authority: BuilderAuthority,
  rootId: string,
  cause: BuilderAuthorityError,
): Promise<never> => {
  const manage = await authority.require(installationOperation(rootId, false));
  return manage.outcome === "refused"
    ? refuseInstallationAuthority(cause)
    : installationProblem("builder_authority_refused", "refused", undefined, { cause });
};

export const installationOperation = (rootId: string, containsCustomComponents: boolean) =>
  ({
    kind: "installation" as const,
    applicationRootId: rootId,
    change: "install_or_upgrade" as const,
    containsCustomComponents,
    acceptedPermissions: [],
  }) satisfies BuilderOperation;

/** A refusal of the installation permissions, named so the person is told what is missing. */
export const refuseInstallationAuthority = (cause: unknown): never => {
  throw new InstallationProblem(
    { kind: "refused", memberRoleRefusal: "installation_authority" },
    "installation_authority_refused",
    { cause },
  );
};

const readRequirementDeadlines = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  context: InstallationHumanContext,
  permissions: PlatformPermissionSource,
  requirements: ReturnType<typeof deriveBuilderRequirements>,
): Promise<string[]> => {
  const deadlines: string[] = [];
  for (const [index, key] of requirements.permissionKeys.entries()) {
    const deadline = readInstallationPermissionDeadline(
      transaction,
      scope,
      context,
      permissions,
      key,
      requirements.recentAuthentication && index === 0,
    );
    // Only a refused Manage applications is named; another requirement (custom code) stays untyped.
    deadlines.push(
      await (key === builderPermissionKeys.applicationsManage
        ? deadline.catch((error: unknown) => {
            if (error instanceof InstallationProblem && error.problem.kind === "refused")
              return refuseInstallationAuthority(error);
            throw error;
          })
        : deadline),
    );
  }
  return deadlines;
};

/** The database deadline of every permission an install or upgrade of this application needs. */
export const readInstallationAuthorityDeadlines = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  context: InstallationHumanContext,
  permissions: PlatformPermissionSource,
  rootId: string,
  containsCustomComponents: boolean,
): Promise<readonly string[]> => {
  const operation = installationOperation(rootId, containsCustomComponents);
  const facts = await installationTargetFacts(transaction, scope, rootId);
  const requirements = deriveBuilderRequirements(operation, facts);
  if (
    requirements.refused ||
    requirements.permissionKeys.length === 0 ||
    requirements.delegatedPermissions.length !== 0
  )
    installationProblem("installation_requirements_refused", "refused");
  return readRequirementDeadlines(transaction, scope, context, permissions, requirements);
};

type PreparedFirstInstallRegistration = ReturnType<
  typeof prepareApplicationRoleTemplatesForHumanRequest
>;

/** Every permission the prepared role templates would confer, deduplicated by exact identity. */
export const firstInstallConferredPermissions = (
  prepared: PreparedFirstInstallRegistration,
): readonly BuilderConferredPermission[] => {
  const conferred = new Map<string, BuilderConferredPermission>();
  for (const template of prepared.templates) {
    for (const entry of [
      ...projectLiveApplicationRolePermissions(
        template.template.permissionSelection,
        prepared.permissionRegistration.applicationRootId,
        template.sourcePermissions,
      ),
      ...template.livePermissions,
    ]) {
      const permission: BuilderConferredPermission = {
        applicationRootId: String(entry.applicationRootId),
        ownerKind: entry.ownerKind,
        ownerId: String(entry.ownerId),
        permissionId: String(entry.permission.permissionId),
      };
      conferred.set(
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
    }
  }
  return [...conferred.values()];
};

/** The database deadline of every permission one builder operation needs, including delegated ones. */
export const readBuilderOperationDeadlines = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  context: InstallationHumanContext,
  permissions: PlatformPermissionSource,
  operation: BuilderOperation,
): Promise<readonly string[]> => {
  const facts = await installationTargetFacts(
    transaction,
    scope,
    operation.kind === "installation" ? operation.applicationRootId : operation.rootId,
  );
  const requirements = deriveBuilderRequirements(operation, facts);
  if (requirements.refused || requirements.permissionKeys.length === 0)
    installationProblem("builder_requirements_refused", "refused");

  const deadlines = await readRequirementDeadlines(
    transaction,
    scope,
    context,
    permissions,
    requirements,
  );

  if (requirements.delegatedPermissions.length > 0) {
    const applications = permissions.declarations.find(
      (entry) => entry.key === "platform.organization.applications.manage",
    );
    if (applications === undefined)
      installationProblem("permission_undeclared", "temporarily_unavailable");
    const decision = await runOrganizationAccessOperation(
      transaction,
      scope,
      organizationAccessDeclarationSchema.parse({
        operationKey: "platform.organization.application_role_templates.accept",
        action: { actionKind: applications.actionKind },
        target: { kind: "organization" },
        requiredPermission: {
          ownerKind: "platform",
          ownerId: permissions.ownerId,
          permissionId: applications.permissionId,
        },
        recentAuthentication: requirements.recentAuthentication
          ? builderRecentAuthentication
          : { kind: "none" },
        authority: {
          kind: "delegated_management",
          before: { kind: "none" },
          after: {
            kind: "bounded",
            permissions: requirements.delegatedPermissions.map((permission) => ({
              applicationRootId: permission.applicationRootId.toLowerCase(),
              ownerKind: permission.ownerKind,
              ownerId: permission.ownerId.toLowerCase(),
              permissionId: permission.permissionId.toLowerCase(),
            })),
          },
        },
      }),
      async (allowed) => allowed,
    );
    if (decision.outcome !== "completed")
      installationProblem(
        `delegated_permission_${decision.reasonCode}`,
        decision.reasonCode === "authentication_required" ? "authentication_required" : "refused",
      );
    deadlines.push(eligibleUntil(decision.value, context));
  }
  return deadlines;
};
