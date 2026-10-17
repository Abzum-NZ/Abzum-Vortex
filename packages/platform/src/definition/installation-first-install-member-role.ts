import "server-only";

import { createHash } from "node:crypto";
import type { createOrganizationAccessAdministrationService } from "../access/index";
import type { BuilderConferredPermission } from "../access/index";
import {
  assignOrganizationAdministrationRoleAssignmentCommandSchema,
  changeOrganizationAdministrationRoleAuthorityCommandSchema,
  prepareOrganizationAdministrationRoleChangeCommandSchema,
  sameId,
  type ApplicationRootId,
  type IdentitySession,
  type OrganizationAdministrationRoleAssignment,
  type OrganizationAdministrationRoleSummary,
  type SystemApplicationBoundReleaseSetResult,
} from "../schema";
import {
  installationOperation,
  installationProblem,
  requireInstallationAuthority,
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

type AccessAdministration = ReturnType<typeof createOrganizationAccessAdministrationService>;

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

const unavailable = (detail: string, kind: "refused" | "temporarily_unavailable"): never =>
  installationProblem(detail, kind);

const requireAvailable = <Value>(
  detail: string,
  result: Readonly<{ kind: "available"; value: Value }> | Readonly<{ kind: string }>,
): Value => {
  if (result.kind === "available" && "value" in result) return result.value as Value;
  return unavailable(
    detail,
    result.kind === "temporarily_unavailable" ? "temporarily_unavailable" : "refused",
  );
};

/** The installer's current role accepted from this template, if one already exists. */
const findAcceptedRole = async (
  administration: AccessAdministration,
  session: IdentitySession,
  selector: FirstInstallSelector,
  sourceRoleId: string,
): Promise<OrganizationAdministrationRoleSummary | undefined> => {
  let afterRoleId: OrganizationAdministrationRoleSummary["roleId"] | undefined;
  for (;;) {
    const page = requireAvailable(
      "first_install_member_role_roles_unreadable",
      await administration.listRoles(
        session,
        { organizationId: selector.organizationId },
        {
          pageSize: 100,
          ...(afterRoleId === undefined ? {} : { afterRoleId }),
        },
      ),
    );
    const found = page.roles.find(
      (role) =>
        role.source.kind === "application" &&
        sameId(role.source.applicationRootId, selector.rootId) &&
        sameId(role.source.sourceRoleId, sourceRoleId) &&
        role.lifecycle !== "retired",
    );
    if (found !== undefined) return found;
    afterRoleId = page.nextAfterRoleId;
    if (afterRoleId === undefined) return undefined;
  }
};

/** Whether the installer already holds a live, active standing assignment of the role. */
const holdsRole = async (
  administration: AccessAdministration,
  session: IdentitySession,
  selector: FirstInstallSelector,
  roleId: string,
  organizationAccountId: string,
): Promise<boolean> => {
  let afterRoleAssignmentId:
    OrganizationAdministrationRoleAssignment["roleAssignmentId"] | undefined;
  for (;;) {
    const page = requireAvailable(
      "first_install_member_role_assignments_unreadable",
      await administration.listRoleAssignments(
        session,
        { organizationId: selector.organizationId },
        {
          pageSize: 100,
          ...(afterRoleAssignmentId === undefined ? {} : { afterRoleAssignmentId }),
        },
      ),
    );
    if (
      page.assignments.some(
        (assignment) =>
          sameId(assignment.role.roleId, roleId) &&
          assignment.assignee.kind === "organization_account" &&
          sameId(assignment.assignee.organizationAccountId, organizationAccountId) &&
          assignment.state === "live" &&
          assignment.temporalState === "active" &&
          assignment.assignmentKind === "standing",
      )
    )
      return true;
    afterRoleAssignmentId = page.nextAfterRoleAssignmentId;
    if (afterRoleAssignmentId === undefined) return false;
  }
};

/**
 * Proves, before anything is written, that the installer may accept the role now: the
 * role-template acceptance rule of the builder authority requires a primary sign-in within the
 * last 15 minutes and every conferred permission inside the installer's delegated scope. A stale
 * sign-in is refused as `authentication_required`, which the install screen shows as
 * "Sign in again to install". The acceptance operation re-checks both itself.
 */
export const requireRoleAcceptanceAuthority = async (
  environment: Pick<FirstInstallFlowEnvironment, "requests" | "permissions">,
  session: IdentitySession,
  selector: Pick<FirstInstallSelector, "organizationId" | "rootId">,
  containsCustomComponents: boolean,
  conferred: readonly BuilderConferredPermission[],
): Promise<string> => {
  let failure: unknown;
  const result = await environment.requests.runChange(
    session,
    { organizationId: selector.organizationId },
    async (transaction, scope) => {
      try {
        if (
          scope.applicationRootId !== undefined ||
          !sameId(scope.organizationId, selector.organizationId)
        )
          installationProblem("role_acceptance_scope_mismatch", "refused");
        await requireInstallationAuthority(transaction, scope, environment.permissions, {
          ...installationOperation(selector.rootId, containsCustomComponents),
          acceptedPermissions: conferred,
        });
        return scope.organizationAccountId;
      } catch (error) {
        failure = error;
        throw error;
      }
    },
  );
  if (result.kind === "available") return result.value;
  if (failure !== undefined) throw failure;
  return unavailable(
    "role_acceptance_authority_unavailable",
    result.kind === "temporarily_unavailable" ? "temporarily_unavailable" : "refused",
  );
};

/**
 * The installer's explicit acceptance of the application's default member role on a FIRST install.
 * It runs before the activation switch, through the existing Access operations only, so every
 * check stays theirs: accepting the template (`accept_new_application_role`) needs the
 * role-management permission, delegated scope over its permissions and a recent primary sign-in;
 * assigning it needs the assignment permission and the same delegated scope.
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

  let role = await findAcceptedRole(administration, session, selector, memberRole.sourceRoleId);
  let organizationAccountId: string;
  if (role === undefined) {
    const prepared = requireAvailable(
      "first_install_member_role_preparation_refused",
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
    organizationAccountId = await requireRoleAcceptanceAuthority(
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
    role = requireAvailable(
      "first_install_member_role_acceptance_refused",
      await administration.acceptApplicationRoleTemplate(
        session,
        selection,
        changeOrganizationAdministrationRoleAuthorityCommandSchema.parse({ evidence: prepared }),
      ),
    ).role;
  } else {
    organizationAccountId = await requireRoleAcceptanceAuthority(
      environment,
      session,
      selector,
      containsCustomComponents,
      [],
    );
    if (await holdsRole(administration, session, selector, role.roleId, organizationAccountId))
      return;
  }
  if (
    role.lifecycle !== "active" ||
    role.assignmentPolicy.kind !== "standing" ||
    role.source.kind !== "application" ||
    !sameId(role.source.applicationRootId, rootId) ||
    !sameId(role.source.sourceRoleId, memberRole.sourceRoleId)
  )
    installationProblem("first_install_member_role_not_assignable", "conflict");

  const assigned = requireAvailable(
    "first_install_member_role_assignment_refused",
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
