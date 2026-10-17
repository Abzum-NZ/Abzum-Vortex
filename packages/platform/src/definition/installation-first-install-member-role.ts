import "server-only";

import { createHash } from "node:crypto";
import type { BuilderConferredPermission } from "../access/index";
import { z } from "zod";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";
import {
  assignOrganizationAdministrationRoleAssignmentCommandSchema,
  changeOrganizationAdministrationRoleAuthorityCommandSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  prepareOrganizationAdministrationRoleChangeCommandSchema,
  roleIdSchema,
  sameId,
  type SelectedOrganizationScope,
  type ApplicationRootId,
  type IdentitySession,
  type SystemApplicationBoundReleaseSetResult,
} from "../schema";
import {
  InstallationProblem,
  installationOperation,
  installationProblem,
  readInstallationHumanContext,
  readInstallationPermissionDeadline,
  requireInstallationAuthority,
  type InstallationMissingAuthority,
} from "./installation-authority";
import type {
  FirstInstallCandidate,
  FirstInstallFlowEnvironment,
} from "./installation-first-install-app";
import type { FirstInstallSelector } from "./installation-first-install";
import {
  createFirstInstallCoordinator,
  verifyFirstInstallActivation,
} from "./installation-first-install-coordinator";
import type { ApplicationInstallationActivationResult } from "./installation-coordinator-contracts";

/** The release's default member role exactly as the install screen shows it to the installer. */
export type FirstInstallMemberRole = Readonly<{
  sourceRoleId: string;
  key: string;
  name: string;
  /** True when the role confers an administrative permission. */
  privileged: boolean;
  permissions: readonly Readonly<{ key: string; label: string }>[];
}>;

/** What the installer chose on the install screen for the default member role. */
export type FirstInstallMemberRoleChoice =
  Readonly<{ kind: "accept"; sourceRoleId: string }> | Readonly<{ kind: "decline" }>;

/**
 * The organisation role key an accepted Application role template gets. It is derived from the
 * template identity, so accepting the same template always names the same local role.
 */
export const acceptedApplicationRoleKey = (
  applicationRootId: string,
  sourceRoleId: string,
  templateKey: string,
): string => {
  const digest = createHash("sha256")
    .update(`${applicationRootId.toLowerCase()}:${sourceRoleId.toLowerCase()}`)
    .digest("hex")
    .slice(0, 12);
  const readableKey = templateKey.slice(0, 20).replace(/_+$/, "") || "role";
  return `local_${readableKey}_${digest}`;
};

/**
 * The one role the release marks `defaultMember`. The compiled contract requires exactly one, so
 * anything else is a release the platform did not produce and the install is refused.
 */
export const firstInstallMemberRole = (
  releaseSet: SystemApplicationBoundReleaseSetResult,
): FirstInstallMemberRole => {
  const marked = releaseSet.application.content.roles.filter((role) => role.defaultMember === true);
  const role = marked[0];
  if (marked.length !== 1 || role === undefined)
    return installationProblem("first_install_member_role_unavailable", "failed");
  const declarations = new Map(
    [
      ...releaseSet.application.content.permissions,
      ...releaseSet.modules.flatMap((module) => module.content.permissions),
    ].map((declaration) => [declaration.key, declaration]),
  );
  return {
    sourceRoleId: String(role.roleId),
    key: role.key,
    name: role.name,
    privileged: role.permissionKeys.some((key) => declarations.get(key)?.administrative === true),
    permissions: role.permissionKeys.map((key) => ({
      key,
      label: declarations.get(key)?.label ?? key,
    })),
  };
};

/** What the installer is missing when the member role cannot be accepted or assigned. */
type FirstInstallMissingAuthority = InstallationMissingAuthority;

/** A refusal that names what the installer lacks, so the install screen can say it plainly. */
const refusedFor = (
  detail: string,
  missingAuthority: FirstInstallMissingAuthority,
  cause?: unknown,
): never => {
  throw new InstallationProblem(
    { kind: "refused", missingAuthority },
    detail,
    cause === undefined ? undefined : { cause },
  );
};

/** Turns a check's refusal into the named refusal; a stale sign-in and other failures keep their own meaning. */
const named = async <Value>(
  detail: string,
  missingAuthority: FirstInstallMissingAuthority,
  check: () => Promise<Value>,
): Promise<Value> => {
  try {
    return await check();
  } catch (error) {
    if (error instanceof InstallationProblem && error.problem.kind === "refused")
      return refusedFor(detail, missingAuthority, error);
    throw error;
  }
};

const requireAvailable = <Value>(
  detail: string,
  missingAuthority: FirstInstallMissingAuthority,
  result: Readonly<{ kind: "available"; value: Value }> | Readonly<{ kind: string }>,
): Value => {
  if (result.kind === "available" && "value" in result) return result.value as Value;
  if (result.kind === "temporarily_unavailable")
    return installationProblem(detail, "temporarily_unavailable");
  return refusedFor(detail, missingAuthority);
};

const memberRoleStateSchema = z
  .object({
    organizationId: organizationIdSchema,
    organizationAccountId: organizationAccountIdSchema,
    role: z
      .object({
        roleId: roleIdSchema,
        liveRevision: z.number().int().min(1),
        lifecycle: z.enum(["active", "acceptance_required", "unavailable"]),
        assignmentPolicy: z.enum(["standing", "activation_required"]),
      })
      .strict()
      .nullable(),
    installerHoldsRole: z.boolean(),
  })
  .strict();

type MemberRoleState = z.infer<typeof memberRoleStateSchema>;

/** Runs one installer request transaction; a failure inside it is rethrown with its own cause. */
const inInstallerRequest = async <Value>(
  environment: FirstInstallFlowEnvironment,
  session: IdentitySession,
  selector: FirstInstallSelector,
  operation: (
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
    issuedAt: string,
  ) => Promise<Value>,
): Promise<Value> => {
  let failure: unknown;
  const result = await environment.requests.runChange(
    session,
    { organizationId: selector.organizationId },
    async (transaction, scope, issuedAt) => {
      try {
        if (
          scope.applicationRootId !== undefined ||
          !sameId(scope.organizationId, selector.organizationId)
        )
          installationProblem("first_install_member_role_scope_mismatch", "refused");
        return await operation(transaction, scope, issuedAt);
      } catch (error) {
        failure = error;
        throw error;
      }
    },
  );
  if (result.kind === "available") return result.value;
  if (failure !== undefined) throw failure;
  return result.kind === "temporarily_unavailable"
    ? installationProblem(
        "first_install_member_role_request_unavailable",
        "temporarily_unavailable",
      )
    : refusedFor("first_install_member_role_request_refused", "installation_authority");
};

/**
 * Reads, under the installer's own installation authority, whether this template's role is
 * already accepted and whether the installer already holds it, and proves the permissions the
 * remaining steps need. Reading the one template being accepted is part of the installation
 * authority, so no roles.read grant is needed; the accept and assign operations still check
 * their own permissions and delegation when they run.
 */
const readMemberRoleState = (
  environment: FirstInstallFlowEnvironment,
  session: IdentitySession,
  selector: FirstInstallSelector,
  sourceRoleId: string,
  containsCustomComponents: boolean,
): Promise<MemberRoleState> =>
  inInstallerRequest(environment, session, selector, async (transaction, scope, issuedAt) => {
    const context = await readInstallationHumanContext(transaction, scope, session, issuedAt, {
      organizationId: selector.organizationId,
    });
    await named("first_install_member_role_installation_refused", "installation_authority", () =>
      requireInstallationAuthority(
        transaction,
        scope,
        environment.permissions,
        installationOperation(selector.rootId, containsCustomComponents),
      ),
    );
    const rows = await transaction.query<DatabaseRow & { readonly member_role: unknown }>`
      select vortex_access.read_first_install_member_role(
        ${selector.rootId}::uuid, ${sourceRoleId}::uuid
      ) as member_role
    `;
    const state = memberRoleStateSchema.safeParse(rows[0]?.member_role);
    if (
      rows.length !== 1 ||
      !state.success ||
      !sameId(state.data.organizationId, scope.organizationId) ||
      !sameId(state.data.organizationAccountId, scope.organizationAccountId)
    )
      return installationProblem("first_install_member_role_state_invalid", "failed", undefined, {
        cause: state.success ? undefined : state.error,
      });
    if (state.data.installerHoldsRole) return state.data;
    if (state.data.role === null)
      await named("first_install_member_role_roles_manage_refused", "roles_manage", () =>
        readInstallationPermissionDeadline(
          transaction,
          scope,
          context,
          environment.permissions,
          "platform.organization.roles.manage",
        ),
      );
    await named("first_install_member_role_assignments_manage_refused", "assignments_manage", () =>
      readInstallationPermissionDeadline(
        transaction,
        scope,
        context,
        environment.permissions,
        "platform.organization.assignments.manage",
      ),
    );
    return state.data;
  });

/**
 * Proves, before the role is accepted, the role-template acceptance rule of the builder authority:
 * a primary sign-in within the last 15 minutes and every conferred permission inside the
 * installer's delegated scope. A stale sign-in is refused as `authentication_required`, which the
 * install screen shows as "Sign in again to install". The acceptance operation re-checks both.
 */
const requireAcceptanceAuthority = (
  environment: FirstInstallFlowEnvironment,
  session: IdentitySession,
  selector: FirstInstallSelector,
  containsCustomComponents: boolean,
  conferred: readonly BuilderConferredPermission[],
): Promise<void> =>
  inInstallerRequest(environment, session, selector, (transaction, scope) =>
    named("first_install_member_role_delegation_refused", "member_role_delegation", () =>
      requireInstallationAuthority(transaction, scope, environment.permissions, {
        ...installationOperation(selector.rootId, containsCustomComponents),
        acceptedPermissions: conferred,
      }),
    ),
  );

/**
 * The installer's explicit acceptance of the application's default member role on a FIRST install.
 * It runs before the activation switch. It reads the template's role under the installation
 * authority, then changes Access only through the existing operations, so every check stays
 * theirs: accepting the template (`accept_new_application_role`) needs the role-management
 * permission, delegated scope over its permissions and a recent primary sign-in; assigning it needs
 * the assignment permission and the same delegated scope. Every refusal names what is missing.
 *
 * Each operation advances the organisation Access version that a human request transaction is
 * pinned to, so each commits in its own transaction, and the activation switch that follows starts
 * a fresh one. A refusal here leaves nothing installed. If the switch then fails, the installer
 * holds a role of an application that is not active, which opens nothing; retrying finds the
 * accepted role and the assignment and does not repeat them. Upgrades never reach this step.
 */
const acceptFirstInstallMemberRole = async (
  environment: FirstInstallFlowEnvironment,
  session: IdentitySession,
  selector: FirstInstallSelector,
  releaseSet: SystemApplicationBoundReleaseSetResult,
  choice: Extract<FirstInstallMemberRoleChoice, { kind: "accept" }>,
): Promise<void> => {
  const memberRole = firstInstallMemberRole(releaseSet);
  if (!sameId(memberRole.sourceRoleId, choice.sourceRoleId))
    installationProblem("first_install_member_role_changed", "conflict");
  const administration = environment.accessAdministration;
  const selection = { organizationId: selector.organizationId };
  const containsCustomComponents = environment.containsCustomComponents(releaseSet);
  const rootId: ApplicationRootId = selector.rootId;

  const state = await readMemberRoleState(
    environment,
    session,
    selector,
    memberRole.sourceRoleId,
    containsCustomComponents,
  );
  if (state.installerHoldsRole) return;
  let role: Readonly<{
    roleId: string;
    liveRevision: number;
    lifecycle: string;
    standing: boolean;
  }>;
  if (state.role === null) {
    const prepared = requireAvailable(
      "first_install_member_role_preparation_refused",
      "roles_manage",
      await administration.prepareRoleChange(
        session,
        selection,
        prepareOrganizationAdministrationRoleChangeCommandSchema.parse({
          operation: "accept_new_application_role",
          roleKey: acceptedApplicationRoleKey(rootId, memberRole.sourceRoleId, memberRole.key),
          label: memberRole.name,
          description: `Accepted from the ${memberRole.key} role template when the application was first installed.`,
          privilegeClassification: memberRole.privileged ? "privileged" : "standard",
          templateApplicationRootId: rootId,
          sourceRoleId: memberRole.sourceRoleId,
          acceptBroadenedAuthority: "accept",
        }),
      ),
    );
    const candidate = prepared.candidate;
    if (candidate.operation !== "accept_new_application_role")
      installationProblem("first_install_member_role_preparation_invalid", "failed");
    await requireAcceptanceAuthority(
      environment,
      session,
      selector,
      containsCustomComponents,
      candidate.permissions.map((permission) => ({
        applicationRootId: String(permission.applicationRootId),
        ownerKind: permission.ownerKind as BuilderConferredPermission["ownerKind"],
        ownerId: String(permission.ownerId),
        permissionId: String(permission.permissionId),
      })),
    );
    const accepted = requireAvailable(
      "first_install_member_role_acceptance_refused",
      "roles_manage",
      await administration.acceptApplicationRoleTemplate(
        session,
        selection,
        changeOrganizationAdministrationRoleAuthorityCommandSchema.parse({ evidence: prepared }),
      ),
    ).role;
    if (
      accepted.source.kind !== "application" ||
      !sameId(accepted.source.applicationRootId, rootId) ||
      !sameId(accepted.source.sourceRoleId, memberRole.sourceRoleId)
    )
      installationProblem("first_install_member_role_acceptance_mismatch", "failed");
    role = {
      roleId: accepted.roleId,
      liveRevision: accepted.liveRevision,
      lifecycle: accepted.lifecycle,
      standing: accepted.assignmentPolicy.kind === "standing",
    };
  } else {
    role = {
      roleId: state.role.roleId,
      liveRevision: state.role.liveRevision,
      lifecycle: state.role.lifecycle,
      standing: state.role.assignmentPolicy === "standing",
    };
  }
  if (role.lifecycle !== "active" || !role.standing)
    installationProblem("first_install_member_role_not_assignable", "conflict");

  const organizationAccountId = state.organizationAccountId;
  const assigned = requireAvailable(
    "first_install_member_role_assignment_refused",
    "assignments_manage",
    await administration.assignRoleAssignment(
      session,
      selection,
      assignOrganizationAdministrationRoleAssignmentCommandSchema.parse({
        roleId: role.roleId,
        expectedRoleRevision: role.liveRevision,
        assigneeKind: "organization_account",
        organizationAccountId,
        assignmentKind: "standing",
      }),
    ),
  ).assignment;
  if (
    assigned.state !== "live" ||
    assigned.temporalState !== "active" ||
    assigned.assignmentKind !== "standing" ||
    !sameId(assigned.role.roleId, role.roleId) ||
    assigned.assignee.kind !== "organization_account" ||
    !sameId(assigned.assignee.organizationAccountId, organizationAccountId)
  )
    installationProblem("first_install_member_role_assignment_mismatch", "failed");
};

/**
 * The one first-install activation the Studio and the App Store share. With the installer's
 * explicit acceptance it first gives them the default member role (above); then it activates the
 * exact prepared release and proves the result names it. Declining activates without a role, and
 * organisation administrators assign roles as for any other application.
 */
export const activateFirstInstall = async (
  environment: FirstInstallFlowEnvironment,
  candidate: FirstInstallCandidate,
  choice: FirstInstallMemberRoleChoice,
): Promise<ApplicationInstallationActivationResult<unknown>> => {
  if (choice.kind === "accept")
    await acceptFirstInstallMemberRole(
      environment,
      candidate.session,
      candidate.selector,
      candidate.releaseSet,
      choice,
    );
  const coordinator = createFirstInstallCoordinator(
    environment,
    candidate.selector,
    candidate.snapshot,
    candidate.releaseSet,
    "activate",
  );
  const result = await coordinator.activate(candidate.session, {
    organizationId: candidate.selector.organizationId,
    applicationRootId: candidate.selector.rootId,
    applicationReleaseRevision: candidate.selector.releaseRevision,
    expectedActiveReleaseRevision: null,
  });
  verifyFirstInstallActivation(result, candidate.selector, candidate.releaseSet);
  return result;
};
