import "server-only";

import {
  assignOrganizationAdministrationRoleAssignmentCommandSchema,
  revokeOrganizationAdministrationRoleAssignmentCommandSchema,
  sameId,
  type IdentitySession,
} from "../schema";
import {
  InstallationProblem,
  installationProblem,
  readInstallationHumanContext,
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
import {
  acceptApplicationRoleChanges,
  applicationRoleChanges,
  inInstallerRequest,
  readInstallationRoles,
  readInstallationRolesIn,
  refusedFor,
  releaseMemberRole,
  requireInstallerPermission,
  requireRoleAcceptanceAuthority,
} from "./installation-role-templates";

/** Whether the installer asked to take the application's default member role themselves. */
export type FirstInstallMemberRoleChoice =
  Readonly<{ kind: "accept"; sourceRoleId: string }> | Readonly<{ kind: "decline" }>;

/** Proves assignment management in its own installer transaction. */
const proveAssignmentManagement = (
  environment: FirstInstallFlowEnvironment,
  session: IdentitySession,
  selector: FirstInstallSelector,
): Promise<void> =>
  inInstallerRequest(environment, session, selector, async (transaction, scope, issuedAt) =>
    requireInstallerPermission(
      transaction,
      scope,
      await readInstallationHumanContext(transaction, scope, session, issuedAt, {
        organizationId: selector.organizationId,
      }),
      environment,
      "platform.organization.assignments.manage",
    ),
  );

/**
 * Whether the installer may take the default member role while installing. Giving oneself a role
 * is an assignment, so it needs assignment management on top of the installation authority; the
 * install screen offers the choice only then.
 */
export const readMemberRoleAssignable = async (
  environment: FirstInstallFlowEnvironment,
  session: IdentitySession,
  selector: FirstInstallSelector,
): Promise<boolean> => {
  try {
    await proveAssignmentManagement(environment, session, selector);
    return true;
  } catch (error) {
    if (error instanceof InstallationProblem && error.problem.kind === "refused") return false;
    throw error;
  }
};

/**
 * Names an assignment that declined or failed. The permission was proved just before the
 * assignment's own transaction, so it is proved again: still held means someone else changed
 * access in between, not held means the permission itself.
 */
const assignmentDeclined = async (
  environment: FirstInstallFlowEnvironment,
  session: IdentitySession,
  selector: FirstInstallSelector,
  detail: string,
): Promise<never> => {
  await proveAssignmentManagement(environment, session, selector);
  return refusedFor(detail, "access_changed");
};

/**
 * The roles of a FIRST install, before the activation switch. Every role the release offers
 * becomes an organisation role, accepted under the installer's installation authority alone, so
 * the application's roles can be given to people as soon as it is installed; nobody holds one
 * until it is assigned. All role acceptances commit together through the existing Access
 * operation, which re-checks Manage applications, the delegated scope over every permission and a
 * recent primary sign-in. With the installer's explicit choice (offered only when they may manage
 * assignments) the default member role is then assigned to them.
 *
 * A refusal leaves nothing installed. Roles accepted before a failed activation open nothing,
 * because the application is not active: a retry finds them and does not accept them again, and
 * declining the member role on a retry revokes the assignment the installer gave themselves. A
 * role that was retired (for example before an uninstall) is never accepted a second time.
 */
const applyFirstInstallRoles = async (
  environment: FirstInstallFlowEnvironment,
  candidate: FirstInstallCandidate,
  choice: FirstInstallMemberRoleChoice,
): Promise<void> => {
  const { session, selector, releaseSet } = candidate;
  const memberRole = releaseMemberRole(candidate.snapshot.roles);
  if (choice.kind === "accept" && !sameId(memberRole.sourceRoleId, choice.sourceRoleId))
    installationProblem("first_install_member_role_changed", "conflict");
  const containsCustomComponents = environment.containsCustomComponents(releaseSet);
  const isMember = (sourceRoleId: string) => sameId(sourceRoleId, memberRole.sourceRoleId);

  const before = await inInstallerRequest(
    environment,
    session,
    selector,
    async (transaction, scope, issuedAt) => {
      const roles = await readInstallationRolesIn(
        transaction,
        scope,
        environment,
        selector,
        containsCustomComponents,
      );
      const member = roles.roles.find((role) => isMember(role.sourceRoleId));
      // Taking or giving back the member role is an assignment: prove it before anything changes.
      const assignmentNeeded =
        choice.kind === "accept"
          ? member?.installerAssignment == null
          : member?.installerAssignment?.selfGranted === true;
      if (assignmentNeeded)
        await requireInstallerPermission(
          transaction,
          scope,
          await readInstallationHumanContext(transaction, scope, session, issuedAt, {
            organizationId: selector.organizationId,
          }),
          environment,
          "platform.organization.assignments.manage",
        );
      return roles;
    },
  );

  const member = before.roles.find((role) => isMember(role.sourceRoleId));
  if (
    choice.kind === "accept" &&
    member !== undefined &&
    member.installerAssignment === null &&
    (!["active", "acceptance_required"].includes(member.lifecycle) ||
      member.assignmentPolicy !== "standing")
  )
    refusedFor("first_install_member_role_unavailable_role", "role_unavailable");

  const changes = applicationRoleChanges(before.roles, releaseSet, []);
  await requireRoleAcceptanceAuthority(
    environment,
    session,
    selector,
    containsCustomComponents,
    releaseSet,
    changes.map((change) => change.sourceRoleId),
  );
  const { notAccepted } = await acceptApplicationRoleChanges(
    environment,
    session,
    selector,
    releaseSet,
    changes,
  );
  // Authority was proved just before; a role not accepted now means access changed meanwhile.
  if (notAccepted.length > 0) installationProblem("first_install_roles_not_accepted", "conflict");

  const selection = { organizationId: selector.organizationId };
  if (choice.kind === "decline") {
    const assignment = member?.installerAssignment;
    if (assignment == null || !assignment.selfGranted) return;
    const revoked = await environment.accessAdministration.revokeRoleAssignment(
      session,
      selection,
      revokeOrganizationAdministrationRoleAssignmentCommandSchema.parse({
        roleAssignmentId: assignment.roleAssignmentId,
        expectedAssignmentRevision: assignment.revision,
      }),
    );
    if (revoked.kind !== "available")
      await assignmentDeclined(
        environment,
        session,
        selector,
        "first_install_member_role_revoke_refused",
      );
    return;
  }

  if (member?.installerAssignment != null) return;
  const after = await readInstallationRoles(
    environment,
    session,
    selector,
    containsCustomComponents,
  );
  const role = after.roles.find((candidateRole) => isMember(candidateRole.sourceRoleId));
  if (role === undefined || role.lifecycle !== "active" || role.assignmentPolicy !== "standing")
    return refusedFor("first_install_member_role_unavailable_role", "role_unavailable");
  if (role.installerAssignment !== null) return;
  const organizationAccountId = after.organizationAccountId;
  const assignResult = await environment.accessAdministration.assignRoleAssignment(
    session,
    selection,
    assignOrganizationAdministrationRoleAssignmentCommandSchema.parse({
      roleId: role.roleId,
      expectedRoleRevision: role.liveRevision,
      assigneeKind: "organization_account",
      organizationAccountId,
      assignmentKind: "standing",
    }),
  );
  if (assignResult.kind !== "available" || !("assignment" in assignResult.value))
    return assignmentDeclined(
      environment,
      session,
      selector,
      "first_install_member_role_assignment_refused",
    );
  const assigned = assignResult.value.assignment;
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
 * The one first-install activation. It first makes every role of the release an organisation
 * role and applies the installer's choice for the default member role (above); then it activates
 * the exact prepared release and proves the result names it.
 */
export const activateFirstInstall = async (
  environment: FirstInstallFlowEnvironment,
  candidate: FirstInstallCandidate,
  choice: FirstInstallMemberRoleChoice,
): Promise<ApplicationInstallationActivationResult<unknown>> => {
  await applyFirstInstallRoles(environment, candidate, choice);
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
