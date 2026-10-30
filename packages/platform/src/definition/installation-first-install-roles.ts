import "server-only";

import type { IdentitySession } from "../access/identity-access";
import type { HumanOrganizationRequestResult } from "../access/human-organization-request";
import {
  assignOrganizationAdministrationRoleAssignmentCommandSchema,
  revokeOrganizationAdministrationRoleAssignmentCommandSchema,
} from "../access/organization-access-administration";
import { sameId } from "../catalogue/runtime-primitives";
import {
  InstallationProblem,
  installationProblem,
  readInstallationHumanContext,
} from "./installation-authority";
import type {
  FirstInstallCandidate,
  FirstInstallFlowEnvironment,
} from "./installation-first-install-app";
import type {
  ApplicationLatestRelease,
  FirstInstallRegistrationState,
  FirstInstallSelector,
} from "./installation-first-install";
import {
  createFirstInstallCoordinator,
  verifyFirstInstallActivation,
} from "./installation-first-install-coordinator";
import { readInstallationBindings } from "./installation-binding-reader";
import {
  FirstInstallUnavailable,
  firstInstallLatestReleaseMatches,
  firstInstallState,
} from "./installation-first-install";
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

/** Bind each Access write to a fresh target check in the same exclusive transaction. */
export const accessForInstallationTarget = (
  environment: FirstInstallFlowEnvironment,
  target: Readonly<{
    selector: FirstInstallSelector;
    releaseSet: FirstInstallCandidate["releaseSet"];
    state: FirstInstallRegistrationState;
    latest?: ApplicationLatestRelease;
  }>,
): FirstInstallFlowEnvironment["accessAdministration"] => {
  const write = async <Value>(
    session: IdentitySession,
    selection: { organizationId: FirstInstallSelector["organizationId"] },
    operation: (
      access: FirstInstallFlowEnvironment["accessAdministration"],
    ) => Promise<HumanOrganizationRequestResult<Value>>,
  ): Promise<HumanOrganizationRequestResult<Value>> => {
    let failure: unknown;
    const result = await environment.requests.runAccessChange(
      session,
      selection,
      async (transaction, scope, issuedAt) => {
        try {
          const bindings = await readInstallationBindings(transaction, target.selector.rootId);
          let state;
          try {
            state = firstInstallState(target.selector, target.releaseSet, bindings);
          } catch (error) {
            if (
              error instanceof FirstInstallUnavailable &&
              (error.reason === "already_installed" || error.reason === "installation_incomplete")
            )
              installationProblem("installation_role_target_changed", "conflict");
            throw error;
          }
          if (state !== target.state)
            installationProblem("installation_role_target_changed", "conflict");
          if (target.latest !== undefined)
            await firstInstallLatestReleaseMatches(transaction, target.selector, target.latest);
          return await operation(
            environment.bindAccessAdministration({
              transaction,
              session,
              selection,
              scope,
              issuedAt,
              mode: "access_change",
            }),
          );
        } catch (error) {
          failure = error;
          throw error;
        }
      },
    );
    if (failure !== undefined) throw failure;
    return result.kind === "available" ? result.value : result;
  };
  const access = environment.accessAdministration;
  return {
    ...access,
    acceptApplicationRoles: (session, selection, commands) =>
      write(session, selection, (bound) =>
        bound.acceptApplicationRoles(session, selection, commands),
      ),
    assignRoleAssignment: (session, selection, command) =>
      write(session, selection, (bound) => bound.assignRoleAssignment(session, selection, command)),
    revokeRoleAssignment: (session, selection, command) =>
      write(session, selection, (bound) => bound.revokeRoleAssignment(session, selection, command)),
  };
};

/**
 * The roles of a FIRST install, before the activation switch. Every role the release offers
 * becomes an organisation role, accepted under the installer's installation authority alone, so
 * the application's roles can be given to people as soon as it is installed; nobody holds one
 * until it is assigned. All role acceptances commit together through the existing Access
 * operation, which re-checks Manage applications, the delegated scope over every permission and a
 * recent primary sign-in. With the installer's explicit choice (offered only when they may manage
 * assignments) the default member role is assigned after activation.
 *
 * Roles accepted before a failed activation open nothing because the application is not active.
 * Once activated, a refused assignment leaves the installation as progress for a retry. A retry
 * reuses accepted roles, and declining the member role revokes an assignment the installer gave
 * themselves. A retired role is never accepted a second time.
 */
const applyFirstInstallRoles = async (
  environment: FirstInstallFlowEnvironment,
  candidate: FirstInstallCandidate,
  choice: FirstInstallMemberRoleChoice,
  deferAssignment = false,
): Promise<void> => {
  const { session, selector, releaseSet } = candidate;
  const accessAdministration = accessForInstallationTarget(environment, {
    selector,
    releaseSet,
    state: candidate.snapshot.registrationState,
    latest: candidate.snapshot.latest,
  });
  const memberRole = releaseMemberRole(candidate.snapshot.roles);
  if (choice.kind === "accept" && !sameId(memberRole.sourceRoleId, choice.sourceRoleId))
    installationProblem("first_install_member_role_changed", "conflict");
  const containsCustomComponents = environment.containsCustomComponents(releaseSet);
  const isMember = (sourceRoleId: string) => sameId(sourceRoleId, memberRole.sourceRoleId);

  const before = await inInstallerRequest(environment, session, selector, (transaction, scope) =>
    readInstallationRolesIn(transaction, scope, environment, selector, containsCustomComponents),
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
  // Taking or giving back the member role is an assignment; it is proved last, so the first
  // missing piece named is always the installation authority's.
  const assignmentNeeded =
    choice.kind === "accept"
      ? member?.installerAssignment == null
      : member?.installerAssignment?.selfGranted === true;
  if (assignmentNeeded) await proveAssignmentManagement(environment, session, selector);
  const { notAccepted } = await acceptApplicationRoleChanges(
    { ...environment, accessAdministration },
    session,
    selector,
    releaseSet,
    changes,
  );
  // Authority was proved just before; a role not accepted now means access changed meanwhile.
  if (notAccepted.length > 0) installationProblem("first_install_roles_not_accepted", "conflict");
  if (deferAssignment && choice.kind === "accept") return;

  const selection = { organizationId: selector.organizationId };
  if (choice.kind === "decline") {
    const assignment = member?.installerAssignment;
    if (assignment == null || !assignment.selfGranted) return;
    const revoked = await accessAdministration.revokeRoleAssignment(
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
  const assignResult = await accessAdministration.assignRoleAssignment(
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

/** Reapply the reviewed roles on an active target and verify the installer's member assignment. */
export const resumeFirstInstallRoles = async (
  environment: FirstInstallFlowEnvironment,
  candidate: FirstInstallCandidate,
  choice: FirstInstallMemberRoleChoice,
): Promise<boolean> => {
  await applyFirstInstallRoles(environment, candidate, choice);
  if (choice.kind === "decline") return false;
  const current = await readInstallationRoles(
    environment,
    candidate.session,
    candidate.selector,
    environment.containsCustomComponents(candidate.releaseSet),
  );
  const member = current.roles.find((role) => sameId(role.sourceRoleId, choice.sourceRoleId));
  if (member?.lifecycle !== "active" || member.installerAssignment === null)
    installationProblem("first_install_member_assignment_changed", "conflict");
  return true;
};

/**
 * The one first-install activation. It first makes every role of the release an organisation
 * role, then activates the exact prepared release and proves the result names it. A selected
 * member assignment is applied afterward, as the last step of the install target.
 */
export const activateFirstInstall = async (
  environment: FirstInstallFlowEnvironment,
  candidate: FirstInstallCandidate,
  choice: FirstInstallMemberRoleChoice,
): Promise<ApplicationInstallationActivationResult<unknown>> => {
  await applyFirstInstallRoles(environment, candidate, choice, true);
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
