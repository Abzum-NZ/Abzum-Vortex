import "server-only";

import type { IdentitySession, SelectedOrganizationScope } from "../access/identity-access";
import type { RequestDatabaseTransaction } from "../db/request-transaction";
import type { HumanOrganizationRequestResult } from "../access/human-organization-request";
import {
  assignOrganizationAdministrationRoleAssignmentCommandSchema,
  revokeOrganizationAdministrationRoleAssignmentCommandSchema,
} from "../access/organization-access-administration";
import { isRecord, sameId } from "../catalogue/runtime-primitives";
import {
  InstallationProblem,
  installationProblem,
  readInstallationHumanContext,
  type ReceiptStep,
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

/** The fields of a role assignment the install proves before it counts as the reviewed one. */
type AssignedMemberRole = Readonly<{
  state: string;
  temporalState: string;
  assignmentKind: string;
  role: Readonly<{ roleId: string }>;
  assignee: Readonly<{ kind: string; organizationAccountId?: string }>;
}>;

/**
 * What a target-proving transaction does for the journey's receipt. `complete` runs before the
 * write, because completing checks the request's access version and the write changes it;
 * `verify` checks the written result and, like a refused write, rolls the transaction back.
 */
type TargetFinish<Value> = Readonly<{
  complete: (
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
  ) => Promise<void>;
  verify?: (written: Extract<HumanOrganizationRequestResult<Value>, { kind: "available" }>) => void;
}>;

/** A write that returned a refusal inside a transaction that had already completed the receipt. */
class WriteDeclined<Value> extends Error {
  constructor(readonly result: HumanOrganizationRequestResult<Value>) {
    super("INSTALLATION_WRITE_DECLINED");
  }
}

type InstallationTarget = Readonly<{
  selector: FirstInstallSelector;
  releaseSet: FirstInstallCandidate["releaseSet"];
  state: FirstInstallRegistrationState;
  latest?: ApplicationLatestRelease;
}>;

/**
 * Runs `operation` in one exclusive Access transaction that first proves the installation is still
 * exactly the target. When `finish` is given the journey's receipt completes in the same
 * transaction, so it commits with the write and never without it.
 */
const inInstallationTarget = async <Value>(
  environment: FirstInstallFlowEnvironment,
  target: InstallationTarget,
  session: IdentitySession,
  selection: { organizationId: FirstInstallSelector["organizationId"] },
  operation: (
    access: FirstInstallFlowEnvironment["accessAdministration"],
  ) => Promise<HumanOrganizationRequestResult<Value>>,
  finish?: TargetFinish<Value>,
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
        if (finish !== undefined) await finish.complete(transaction, scope);
        const written = await operation(
          environment.bindAccessAdministration({
            transaction,
            session,
            selection,
            scope,
            issuedAt,
            mode: "access_change",
          }),
        );
        if (finish !== undefined) {
          if (written.kind !== "available") throw new WriteDeclined(written);
          finish.verify?.(written);
        }
        return written;
      } catch (error) {
        failure = error;
        throw error;
      }
    },
  );
  if (failure instanceof WriteDeclined)
    return failure.result as HumanOrganizationRequestResult<Value>;
  if (failure !== undefined) throw failure;
  return result.kind === "available" ? result.value : result;
};

/**
 * Proves in one exclusive transaction that the installation is exactly the target, then runs
 * `finish` there: a journey whose write is already in place completes its receipt after proving
 * the target and nothing else.
 */
export const completeAtInstallationTarget = async (
  environment: FirstInstallFlowEnvironment,
  target: InstallationTarget,
  session: IdentitySession,
  selection: { organizationId: FirstInstallSelector["organizationId"] },
  finish: (
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
  ) => Promise<void>,
): Promise<void> => {
  const result = await inInstallationTarget(
    environment,
    target,
    session,
    selection,
    async () => ({ kind: "available", value: undefined }),
    { complete: finish },
  );
  if (result.kind !== "available")
    installationProblem("installation_receipt_not_completed", "temporarily_unavailable");
};

/**
 * Bind each Access write to a fresh target check in the same exclusive transaction. `final` names
 * the one write that reaches the journey's target; the receipt completes in that transaction.
 */
export const accessForInstallationTarget = (
  environment: FirstInstallFlowEnvironment,
  target: InstallationTarget,
  final?: Readonly<{
    write: "accept_roles" | "assign_role";
    step: TargetFinish<unknown>;
  }>,
): FirstInstallFlowEnvironment["accessAdministration"] => {
  const finishing = (write: "accept_roles" | "assign_role") =>
    final?.write === write ? final.step : undefined;
  const access = environment.accessAdministration;
  return {
    ...access,
    acceptApplicationRoles: (session, selection, commands) =>
      inInstallationTarget(
        environment,
        target,
        session,
        selection,
        (bound) => bound.acceptApplicationRoles(session, selection, commands),
        finishing("accept_roles"),
      ),
    assignRoleAssignment: (session, selection, command) =>
      inInstallationTarget(
        environment,
        target,
        session,
        selection,
        (bound) => bound.assignRoleAssignment(session, selection, command),
        finishing("assign_role"),
      ),
    revokeRoleAssignment: (session, selection, command) =>
      inInstallationTarget(environment, target, session, selection, (bound) =>
        bound.revokeRoleAssignment(session, selection, command),
      ),
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
  complete?: ReceiptStep,
): Promise<boolean> => {
  const { session, selector, releaseSet } = candidate;
  const proof: { verify?: (assigned: unknown) => void } = {};
  // The member assignment is the last step of an install that takes the role: the receipt
  // completes in its transaction, after the assignment is proved to be the reviewed one.
  const accessAdministration = accessForInstallationTarget(
    environment,
    {
      selector,
      releaseSet,
      state: candidate.snapshot.registrationState,
      latest: candidate.snapshot.latest,
    },
    complete !== undefined && choice.kind === "accept" && !deferAssignment
      ? {
          write: "assign_role",
          step: {
            complete: (transaction) => complete(transaction),
            verify: (written) => {
              const value: unknown = written.value;
              proof.verify?.(isRecord(value) ? value.assignment : undefined);
            },
          },
        }
      : undefined,
  );
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
  if (deferAssignment && choice.kind === "accept") return false;

  const selection = { organizationId: selector.organizationId };
  if (choice.kind === "decline") {
    const assignment = member?.installerAssignment;
    if (assignment == null || !assignment.selfGranted) return false;
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
    return false;
  }

  if (member?.installerAssignment != null) return false;
  const after = await readInstallationRoles(
    environment,
    session,
    selector,
    containsCustomComponents,
  );
  const role = after.roles.find((candidateRole) => isMember(candidateRole.sourceRoleId));
  if (role === undefined || role.lifecycle !== "active" || role.assignmentPolicy !== "standing")
    return refusedFor("first_install_member_role_unavailable_role", "role_unavailable");
  if (role.installerAssignment !== null) return false;
  const organizationAccountId = after.organizationAccountId;
  const verifyAssignment = (assigned: unknown): void => {
    const live = assigned as AssignedMemberRole | undefined;
    if (
      live === undefined ||
      live.state !== "live" ||
      live.temporalState !== "active" ||
      live.assignmentKind !== "standing" ||
      !sameId(live.role.roleId, role.roleId) ||
      live.assignee.kind !== "organization_account" ||
      !sameId(live.assignee.organizationAccountId ?? "", organizationAccountId)
    )
      installationProblem("first_install_member_role_assignment_mismatch", "failed");
  };
  proof.verify = verifyAssignment;
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
  verifyAssignment(assignResult.value.assignment);
  return complete !== undefined;
};

/** Reapply the reviewed roles on an active target and verify the installer's member assignment. */
export const resumeFirstInstallRoles = async (
  environment: FirstInstallFlowEnvironment,
  candidate: FirstInstallCandidate,
  choice: FirstInstallMemberRoleChoice,
  complete?: ReceiptStep,
): Promise<boolean> => {
  const completed = await applyFirstInstallRoles(environment, candidate, choice, false, complete);
  const containsCustomComponents = environment.containsCustomComponents(candidate.releaseSet);
  const target = {
    selector: candidate.selector,
    releaseSet: candidate.releaseSet,
    state: candidate.snapshot.registrationState,
    latest: candidate.snapshot.latest,
  };
  const selection = { organizationId: candidate.selector.organizationId };
  if (choice.kind === "decline") {
    if (complete !== undefined)
      await completeAtInstallationTarget(
        environment,
        target,
        candidate.session,
        selection,
        (transaction) => complete(transaction),
      );
    return false;
  }
  const current = await readInstallationRoles(
    environment,
    candidate.session,
    candidate.selector,
    containsCustomComponents,
  );
  const member = current.roles.find((role) => sameId(role.sourceRoleId, choice.sourceRoleId));
  if (member?.lifecycle !== "active" || member.installerAssignment === null)
    installationProblem("first_install_member_assignment_changed", "conflict");
  // Nothing was left to write: prove the reviewed assignment again in the completing transaction.
  if (complete !== undefined && !completed)
    await completeAtInstallationTarget(
      environment,
      target,
      candidate.session,
      selection,
      async (transaction, scope) => {
        const locked = await readInstallationRolesIn(
          transaction,
          scope,
          environment,
          candidate.selector,
          containsCustomComponents,
        );
        const held = locked.roles.find((role) => sameId(role.sourceRoleId, choice.sourceRoleId));
        if (held?.lifecycle !== "active" || held.installerAssignment === null)
          installationProblem("first_install_member_assignment_changed", "conflict");
        await complete(transaction);
      },
    );
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
  complete?: ReceiptStep,
): Promise<ApplicationInstallationActivationResult<unknown>> => {
  await applyFirstInstallRoles(environment, candidate, choice, true);
  const coordinator = createFirstInstallCoordinator(
    environment,
    candidate.selector,
    candidate.snapshot,
    candidate.releaseSet,
    "activate",
    // An install that takes no member role reaches its target by activating.
    choice.kind === "decline" ? complete : undefined,
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
