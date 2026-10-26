import "server-only";

import { randomUUID } from "node:crypto";
import type { IdentitySession, OrganizationSelectionCandidate } from "./identity-access";
import type {
  CloseOrganizationAccountCommand,
  CreateOrganizationInvitationForAdministrationCommand,
  ReactivateOrganizationAccountCommand,
  RevokeOrganizationInvitationForAdministrationCommand,
  SuspendOrganizationAccountCommand,
  UpdateOwnProfileCommand,
  UpdateOwnProfileResult,
} from "./organization-local-administration";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "./human-organization-request";
import { createOrganizationLocalAdministrationService } from "./organization-local-administration-access";
import type { AccessAdministrationContext } from "./organization-access-administration-shared";
import { createAccessAdministrationGroupOperations } from "./organization-access-administration-groups";
import { createAccessAdministrationRoleOperations } from "./organization-access-administration-roles";
import { createAccessAdministrationAssignmentOperations } from "./organization-access-administration-assignments";

export type OrganizationAccessAdministrationDependencies = HumanOrganizationRequestDependencies &
  Readonly<{
    groupId?: () => string;
    membershipId?: () => string;
    roleAssignmentId?: () => string;
    delegationAuthorityId?: () => string;
    activityId?: () => string;
  }>;

export const createOrganizationAccessAdministrationService = (
  dependencies: OrganizationAccessAdministrationDependencies,
) => {
  const context: AccessAdministrationContext = {
    requests: createHumanOrganizationRequestService(dependencies),
    newGroupId: dependencies.groupId ?? randomUUID,
    newMembershipId: dependencies.membershipId ?? randomUUID,
    newRoleAssignmentId: dependencies.roleAssignmentId ?? randomUUID,
    newDelegationAuthorityId: dependencies.delegationAuthorityId ?? randomUUID,
    newActivityId: dependencies.activityId ?? randomUUID,
  };
  // Organisation-account lifecycle and invitation operations are complete in the local
  // administration service; this service exposes them beside the group, role and assignment
  // operations so one executor dependency reaches every protected Access administration change.
  const localAdministration = createOrganizationLocalAdministrationService(dependencies);

  return Object.freeze({
    readOrganizationAccount: localAdministration.readOrganizationAccount,
    ...createAccessAdministrationGroupOperations(context),
    ...createAccessAdministrationRoleOperations(context),
    ...createAccessAdministrationAssignmentOperations(context),

    suspendOrganizationAccount: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: SuspendOrganizationAccountCommand,
    ) => localAdministration.suspendOrganizationAccount(session, candidate, commandCandidate),

    reactivateOrganizationAccount: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ReactivateOrganizationAccountCommand,
    ) => localAdministration.reactivateOrganizationAccount(session, candidate, commandCandidate),

    closeOrganizationAccount: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: CloseOrganizationAccountCommand,
    ) => localAdministration.closeOrganizationAccount(session, candidate, commandCandidate),

    updateOwnProfile: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: UpdateOwnProfileCommand,
    ): Promise<HumanOrganizationRequestResult<UpdateOwnProfileResult | "conflict">> =>
      localAdministration.updateOwnProfile(session, candidate, commandCandidate),

    readOwnProfile: async (session: IdentitySession, candidate: OrganizationSelectionCandidate) =>
      localAdministration.readOwnProfile(session, candidate),

    createOrganizationInvitation: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: CreateOrganizationInvitationForAdministrationCommand,
    ) => localAdministration.createOrganizationInvitation(session, candidate, commandCandidate),

    revokeOrganizationInvitation: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: RevokeOrganizationInvitationForAdministrationCommand,
    ) => localAdministration.revokeOrganizationInvitation(session, candidate, commandCandidate),
  });
};
