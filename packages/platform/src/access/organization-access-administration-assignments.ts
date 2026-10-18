import "server-only";

import {
  databaseRevision,
  sameId,
  activityIdSchema,
  delegationAuthorityIdSchema,
  grantOrganizationAdministrationDelegationAuthorityCommandSchema,
  type GrantOrganizationAdministrationDelegationAuthorityCommand,
  assignOrganizationAdministrationRoleAssignmentCommandSchema,
  changeOrganizationAdministrationDelegationAuthorityResultSchema,
  changeOrganizationAdministrationRoleAssignmentResultSchema,
  changeOrganizationAdministrationRoleActivationResultSchema,
  roleAssignmentIdSchema,
  listOrganizationAdministrationDelegationAuthoritiesCommandSchema,
  listOrganizationAdministrationDelegationAuthoritiesResultSchema,
  listOrganizationAdministrationRoleActivationsCommandSchema,
  listOrganizationAdministrationRoleActivationsResultSchema,
  listOrganizationAdministrationRoleAssignmentsCommandSchema,
  listOrganizationAdministrationRoleAssignmentsResultSchema,
  readOrganizationAdministrationDelegationAuthorityCommandSchema,
  readOrganizationAdministrationDelegationAuthorityResultSchema,
  readOrganizationAdministrationRoleActivationCommandSchema,
  readOrganizationAdministrationRoleActivationResultSchema,
  readOrganizationAdministrationRoleAssignmentCommandSchema,
  readOrganizationAdministrationRoleAssignmentResultSchema,
  deactivateOrganizationAdministrationRoleActivationCommandSchema,
  revokeOrganizationAdministrationDelegationAuthorityCommandSchema,
  revokeOrganizationAdministrationRoleAssignmentCommandSchema,
  organizationStewardshipAppointmentCommandSchema,
  organizationStewardshipAppointmentAttemptSchema,
  organizationStewardshipAppointmentResultSchema,
  type AssignOrganizationAdministrationRoleAssignmentCommand,
  type ChangeOrganizationAdministrationRoleAssignmentResult,
  type ChangeOrganizationAdministrationDelegationAuthorityResult,
  type ChangeOrganizationAdministrationRoleActivationResult,
  type IdentitySession,
  type ListOrganizationAdministrationDelegationAuthoritiesCommand,
  type ListOrganizationAdministrationDelegationAuthoritiesResult,
  type ListOrganizationAdministrationRoleActivationsCommand,
  type ListOrganizationAdministrationRoleActivationsResult,
  type ListOrganizationAdministrationRoleAssignmentsCommand,
  type ListOrganizationAdministrationRoleAssignmentsResult,
  type OrganizationSelectionCandidate,
  type OrganizationStewardshipAppointmentCommand,
  type OrganizationStewardshipAppointmentAttempt,
  type ReadOrganizationAdministrationDelegationAuthorityCommand,
  type ReadOrganizationAdministrationDelegationAuthorityResult,
  type ReadOrganizationAdministrationRoleActivationCommand,
  type ReadOrganizationAdministrationRoleActivationResult,
  type ReadOrganizationAdministrationRoleAssignmentCommand,
  type ReadOrganizationAdministrationRoleAssignmentResult,
  type RevokeOrganizationAdministrationRoleAssignmentCommand,
  type DeactivateOrganizationAdministrationRoleActivationCommand,
  type RevokeOrganizationAdministrationDelegationAuthorityCommand,
} from "../schema";
import type { HumanOrganizationRequestResult } from "./human-organization-request";
import {
  normalizeAssignmentLedgerFact,
  normalizeRoleActivation,
  sameAssignee,
  requireOne,
  recordedRefusal,
  isRecordedRefusal,
  refuseAdministration,
  mapRecordedRefusal,
} from "./organization-access-administration-shared";
import type {
  RoleAssignmentPageRow,
  RoleAssignmentDetailRow,
  RoleAssignmentChangeRow,
  DelegationAuthorityChangeRow,
  StewardshipAppointmentRow,
  RoleActivationChangeRow,
  DelegationAuthorityPageRow,
  DelegationAuthorityDetailRow,
  RoleActivationPageRow,
  RoleActivationDetailRow,
  AccessAdministrationContext,
} from "./organization-access-administration-shared";

export const createAccessAdministrationAssignmentOperations = ({
  requests,
  newRoleAssignmentId,
  newDelegationAuthorityId,
  newActivityId,
}: AccessAdministrationContext) => {
  return {
    assignRoleAssignment: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: AssignOrganizationAdministrationRoleAssignmentCommand,
    ): Promise<
      HumanOrganizationRequestResult<ChangeOrganizationAdministrationRoleAssignmentResult>
    > => {
      const command =
        assignOrganizationAdministrationRoleAssignmentCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return refuseAdministration(
          "assignRoleAssignment",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );
      let roleAssignmentId: string;
      let activityId: string;
      try {
        roleAssignmentId = roleAssignmentIdSchema.parse(newRoleAssignmentId());
        activityId = activityIdSchema.parse(newActivityId());
      } catch (error) {
        return refuseAdministration(
          "assignRoleAssignment",
          "ACCESS_ADMIN_IDENTITY_GENERATION_FAILED",
          { kind: "temporarily_unavailable" } as const,
          error,
        );
      }
      return mapRecordedRefusal(
        "assignRoleAssignment",
        requests.runChange(session, candidate, async (transaction, scope) => {
          const row = requireOne(
            await transaction.query<RoleAssignmentChangeRow>`
          select outcome, organization_id, assignment_summary, access_version
          from vortex_access.assign_organization_role_assignment_for_administration(
            ${roleAssignmentId}::uuid,
            ${command.data.roleId}::uuid,
            ${command.data.expectedRoleRevision}::bigint,
            ${command.data.assigneeKind}::text,
            ${command.data.organizationAccountId ?? null}::uuid,
            ${command.data.groupId ?? null}::uuid,
            ${command.data.assignmentKind}::text,
            ${command.data.startsAt ?? null}::timestamptz,
            ${command.data.expiresAt ?? null}::timestamptz,
            ${activityId}::uuid
          )
        `,
          );
          if (
            isRecordedRefusal(
              row,
              row.assignment_summary,
              scope.organizationId,
              scope.accessVersion,
            )
          )
            return recordedRefusal;
          const parsed = changeOrganizationAdministrationRoleAssignmentResultSchema.safeParse({
            assignment: normalizeAssignmentLedgerFact(row.assignment_summary),
            accessVersion: databaseRevision(row.access_version),
          });
          if (
            typeof row.organization_id !== "string" ||
            !sameId(row.organization_id, scope.organizationId) ||
            row.outcome !== "completed" ||
            !parsed.success ||
            parsed.data.accessVersion !== scope.accessVersion + 1 ||
            !sameId(parsed.data.assignment.roleAssignmentId, roleAssignmentId) ||
            !sameId(parsed.data.assignment.role.roleId, command.data.roleId) ||
            !sameAssignee(parsed.data.assignment.assignee, command.data) ||
            parsed.data.assignment.assignmentKind !== command.data.assignmentKind ||
            parsed.data.assignment.revision !== 1 ||
            parsed.data.assignment.state !== "live"
          )
            throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
          return parsed.data;
        }),
      );
    },

    appointOrganizationSteward: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: OrganizationStewardshipAppointmentCommand,
    ): Promise<HumanOrganizationRequestResult<OrganizationStewardshipAppointmentAttempt>> => {
      const command = organizationStewardshipAppointmentCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return refuseAdministration(
          "appointOrganizationSteward",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );
      return mapRecordedRefusal(
        "appointOrganizationSteward",
        requests.runChange(session, candidate, async (transaction, scope) => {
          const row = requireOne(
            await transaction.query<StewardshipAppointmentRow>`
              select outcome, organization_id, appointment_summary, access_version
              from vortex_access.appoint_organization_steward_for_administration(
                ${command.data.organizationAccountId}::uuid,
                ${command.data.expectedAccountRevision}::bigint
              )
            `,
          );
          if (
            isRecordedRefusal(
              row,
              row.appointment_summary,
              scope.organizationId,
              scope.accessVersion,
            )
          )
            return recordedRefusal;
          if (
            typeof row.organization_id !== "string" ||
            !sameId(row.organization_id, scope.organizationId)
          )
            throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
          if (row.outcome === "conflict") {
            if (
              row.appointment_summary !== null ||
              databaseRevision(row.access_version) !== scope.accessVersion
            )
              throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
            return organizationStewardshipAppointmentAttemptSchema.parse({
              operation: "appoint_organization_steward",
              outcome: "conflict",
            });
          }
          const summary = organizationStewardshipAppointmentResultSchema
            .omit({ operation: true, outcome: true, accessVersion: true })
            .safeParse(row.appointment_summary);
          if (!summary.success) throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
          const parsed = organizationStewardshipAppointmentResultSchema.safeParse({
            ...summary.data,
            operation: "appoint_organization_steward",
            outcome: row.outcome,
            accessVersion: databaseRevision(row.access_version),
          });
          const expectedAccessVersion =
            row.outcome === "changed" ? scope.accessVersion + 1 : scope.accessVersion;
          if (
            typeof row.organization_id !== "string" ||
            !sameId(row.organization_id, scope.organizationId) ||
            !parsed.success ||
            !sameId(parsed.data.organizationAccountId, command.data.organizationAccountId) ||
            parsed.data.accessVersion !== expectedAccessVersion
          )
            throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
          return parsed.data;
        }),
      );
    },

    revokeRoleAssignment: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: RevokeOrganizationAdministrationRoleAssignmentCommand,
    ): Promise<
      HumanOrganizationRequestResult<ChangeOrganizationAdministrationRoleAssignmentResult>
    > => {
      const command =
        revokeOrganizationAdministrationRoleAssignmentCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return refuseAdministration(
          "revokeRoleAssignment",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );
      let activityId: string;
      try {
        activityId = activityIdSchema.parse(newActivityId());
      } catch (error) {
        return refuseAdministration(
          "revokeRoleAssignment",
          "ACCESS_ADMIN_IDENTITY_GENERATION_FAILED",
          { kind: "temporarily_unavailable" } as const,
          error,
        );
      }
      return mapRecordedRefusal(
        "revokeRoleAssignment",
        requests.runChange(session, candidate, async (transaction, scope) => {
          const row = requireOne(
            await transaction.query<RoleAssignmentChangeRow>`
          select outcome, organization_id, assignment_summary, access_version
          from vortex_access.revoke_organization_role_assignment_for_administration(
            ${command.data.roleAssignmentId}::uuid,
            ${command.data.expectedAssignmentRevision}::bigint,
            ${activityId}::uuid
          )
        `,
          );
          if (
            isRecordedRefusal(
              row,
              row.assignment_summary,
              scope.organizationId,
              scope.accessVersion,
            )
          )
            return recordedRefusal;
          const parsed = changeOrganizationAdministrationRoleAssignmentResultSchema.safeParse({
            assignment: normalizeAssignmentLedgerFact(row.assignment_summary),
            accessVersion: databaseRevision(row.access_version),
          });
          if (
            typeof row.organization_id !== "string" ||
            !sameId(row.organization_id, scope.organizationId) ||
            row.outcome !== "completed" ||
            !parsed.success ||
            parsed.data.accessVersion !== scope.accessVersion + 1 ||
            !sameId(parsed.data.assignment.roleAssignmentId, command.data.roleAssignmentId) ||
            parsed.data.assignment.revision !== command.data.expectedAssignmentRevision + 1 ||
            parsed.data.assignment.state !== "revoked" ||
            parsed.data.assignment.temporalState !== "revoked"
          )
            throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
          return parsed.data;
        }),
      );
    },

    deactivateRoleActivation: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: DeactivateOrganizationAdministrationRoleActivationCommand,
    ): Promise<
      HumanOrganizationRequestResult<ChangeOrganizationAdministrationRoleActivationResult>
    > => {
      const command =
        deactivateOrganizationAdministrationRoleActivationCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return refuseAdministration(
          "deactivateRoleActivation",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );
      let activityId: string;
      try {
        activityId = activityIdSchema.parse(newActivityId());
      } catch (error) {
        return refuseAdministration(
          "deactivateRoleActivation",
          "ACCESS_ADMIN_IDENTITY_GENERATION_FAILED",
          { kind: "temporarily_unavailable" } as const,
          error,
        );
      }
      return mapRecordedRefusal(
        "deactivateRoleActivation",
        requests.runChange(session, candidate, async (transaction, scope) => {
          const row = requireOne(
            await transaction.query<RoleActivationChangeRow>`
          select outcome, organization_id, activation_summary, access_version
          from vortex_access.deactivate_organization_role_activation_for_administration(
            ${command.data.roleActivationId}::uuid,
            ${command.data.expectedActivationRevision}::bigint,
            ${activityId}::uuid
          )`,
          );
          if (
            isRecordedRefusal(
              row,
              row.activation_summary,
              scope.organizationId,
              scope.accessVersion,
            )
          )
            return recordedRefusal;
          const parsed = changeOrganizationAdministrationRoleActivationResultSchema.safeParse({
            activation: normalizeRoleActivation(row.activation_summary),
            accessVersion: databaseRevision(row.access_version),
          });
          if (
            typeof row.organization_id !== "string" ||
            !sameId(row.organization_id, scope.organizationId) ||
            row.outcome !== "completed" ||
            !parsed.success ||
            parsed.data.accessVersion !== scope.accessVersion + 1 ||
            !sameId(parsed.data.activation.roleActivationId, command.data.roleActivationId) ||
            parsed.data.activation.revision !== command.data.expectedActivationRevision + 1 ||
            parsed.data.activation.state !== "revoked" ||
            parsed.data.activation.temporalState !== "revoked"
          )
            throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
          return parsed.data;
        }),
      );
    },

    grantDelegationAuthority: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: GrantOrganizationAdministrationDelegationAuthorityCommand,
    ): Promise<
      HumanOrganizationRequestResult<ChangeOrganizationAdministrationDelegationAuthorityResult>
    > => {
      const command =
        grantOrganizationAdministrationDelegationAuthorityCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return refuseAdministration(
          "grantDelegationAuthority",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );
      let activityId: string;
      let delegationAuthorityId: string;
      try {
        activityId = activityIdSchema.parse(newActivityId());
        delegationAuthorityId = delegationAuthorityIdSchema.parse(newDelegationAuthorityId());
      } catch (error) {
        return refuseAdministration(
          "grantDelegationAuthority",
          "ACCESS_ADMIN_IDENTITY_GENERATION_FAILED",
          { kind: "temporarily_unavailable" } as const,
          error,
        );
      }
      return mapRecordedRefusal(
        "grantDelegationAuthority",
        requests.runChange(session, candidate, async (transaction, scope) => {
          const row = requireOne(
            await transaction.query<DelegationAuthorityChangeRow>`
          select outcome, organization_id, delegation_summary, access_version
          from vortex_access.grant_organization_delegation_authority_for_administration(
            ${delegationAuthorityId}::uuid,
            ${command.data.holderKind}::text,
            ${command.data.holderId}::uuid,
            ${command.data.expectedHolderRevision}::bigint,
            ${activityId}::uuid
          )`,
          );
          if (
            isRecordedRefusal(
              row,
              row.delegation_summary,
              scope.organizationId,
              scope.accessVersion,
            )
          )
            return recordedRefusal;
          const parsed = changeOrganizationAdministrationDelegationAuthorityResultSchema.safeParse({
            delegation: normalizeAssignmentLedgerFact(row.delegation_summary),
            accessVersion: databaseRevision(row.access_version),
          });
          if (
            typeof row.organization_id !== "string" ||
            !sameId(row.organization_id, scope.organizationId) ||
            row.outcome !== "completed" ||
            !parsed.success ||
            parsed.data.accessVersion !== scope.accessVersion + 1 ||
            !sameId(parsed.data.delegation.delegationAuthorityId, delegationAuthorityId) ||
            parsed.data.delegation.revision !== 1 ||
            parsed.data.delegation.state !== "live" ||
            parsed.data.delegation.temporalState !== "active" ||
            parsed.data.delegation.scope.kind !== "organization_catalogue" ||
            !sameAssignee(parsed.data.delegation.holder, {
              assigneeKind: command.data.holderKind,
              organizationAccountId:
                command.data.holderKind === "organization_account"
                  ? command.data.holderId
                  : undefined,
              groupId: command.data.holderKind === "group" ? command.data.holderId : undefined,
            })
          )
            throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
          return parsed.data;
        }),
      );
    },

    revokeDelegationAuthority: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: RevokeOrganizationAdministrationDelegationAuthorityCommand,
    ): Promise<
      HumanOrganizationRequestResult<ChangeOrganizationAdministrationDelegationAuthorityResult>
    > => {
      const command =
        revokeOrganizationAdministrationDelegationAuthorityCommandSchema.safeParse(
          commandCandidate,
        );
      if (!command.success)
        return refuseAdministration(
          "revokeDelegationAuthority",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );
      let activityId: string;
      try {
        activityId = activityIdSchema.parse(newActivityId());
      } catch (error) {
        return refuseAdministration(
          "revokeDelegationAuthority",
          "ACCESS_ADMIN_IDENTITY_GENERATION_FAILED",
          { kind: "temporarily_unavailable" } as const,
          error,
        );
      }
      return mapRecordedRefusal(
        "revokeDelegationAuthority",
        requests.runChange(session, candidate, async (transaction, scope) => {
          const row = requireOne(
            await transaction.query<DelegationAuthorityChangeRow>`
          select outcome, organization_id, delegation_summary, access_version
          from vortex_access.revoke_organization_delegation_authority_for_administration(
            ${command.data.delegationAuthorityId}::uuid,
            ${command.data.expectedDelegationRevision}::bigint,
            ${activityId}::uuid
          )`,
          );
          if (
            isRecordedRefusal(
              row,
              row.delegation_summary,
              scope.organizationId,
              scope.accessVersion,
            )
          )
            return recordedRefusal;
          const parsed = changeOrganizationAdministrationDelegationAuthorityResultSchema.safeParse({
            delegation: normalizeAssignmentLedgerFact(row.delegation_summary),
            accessVersion: databaseRevision(row.access_version),
          });
          if (
            typeof row.organization_id !== "string" ||
            !sameId(row.organization_id, scope.organizationId) ||
            row.outcome !== "completed" ||
            !parsed.success ||
            parsed.data.accessVersion !== scope.accessVersion + 1 ||
            !sameId(
              parsed.data.delegation.delegationAuthorityId,
              command.data.delegationAuthorityId,
            ) ||
            parsed.data.delegation.revision !== command.data.expectedDelegationRevision + 1 ||
            parsed.data.delegation.state !== "revoked" ||
            parsed.data.delegation.temporalState !== "revoked"
          )
            throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
          return parsed.data;
        }),
      );
    },

    listRoleAssignments: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ListOrganizationAdministrationRoleAssignmentsCommand,
    ): Promise<
      HumanOrganizationRequestResult<ListOrganizationAdministrationRoleAssignmentsResult>
    > => {
      const command =
        listOrganizationAdministrationRoleAssignmentsCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return refuseAdministration(
          "listRoleAssignments",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );

      return requests.run(session, candidate, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<RoleAssignmentPageRow>`
            select organization_id, assignments, next_after_role_assignment_id,
              access_version
            from vortex_access.list_organization_role_assignments_for_administration(
              ${command.data.afterRoleAssignmentId ?? null}::uuid,
              ${command.data.pageSize}::integer
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameId(row.organization_id, scope.organizationId) ||
          databaseRevision(row.access_version) !== scope.accessVersion ||
          !Array.isArray(row.assignments)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        return listOrganizationAdministrationRoleAssignmentsResultSchema.parse({
          assignments: row.assignments.map(normalizeAssignmentLedgerFact),
          ...(row.next_after_role_assignment_id === null ||
          row.next_after_role_assignment_id === undefined
            ? {}
            : { nextAfterRoleAssignmentId: row.next_after_role_assignment_id }),
          accessVersion: databaseRevision(row.access_version),
        });
      });
    },

    readRoleAssignment: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ReadOrganizationAdministrationRoleAssignmentCommand,
    ): Promise<
      HumanOrganizationRequestResult<ReadOrganizationAdministrationRoleAssignmentResult>
    > => {
      const command =
        readOrganizationAdministrationRoleAssignmentCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return refuseAdministration(
          "readRoleAssignment",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );

      return requests.run(session, candidate, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<RoleAssignmentDetailRow>`
            select organization_id, outcome, assignment_summary, access_version
            from vortex_access.read_organization_role_assignment_for_administration(
              ${command.data.roleAssignmentId}::uuid
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameId(row.organization_id, scope.organizationId) ||
          databaseRevision(row.access_version) !== scope.accessVersion
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        const result = readOrganizationAdministrationRoleAssignmentResultSchema.parse({
          outcome: row.outcome,
          ...(row.assignment_summary === null || row.assignment_summary === undefined
            ? {}
            : { assignment: normalizeAssignmentLedgerFact(row.assignment_summary) }),
          accessVersion: databaseRevision(row.access_version),
        });
        if (
          result.outcome === "available" &&
          !sameId(result.assignment.roleAssignmentId, command.data.roleAssignmentId)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
        return result;
      });
    },

    listDelegationAuthorities: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ListOrganizationAdministrationDelegationAuthoritiesCommand,
    ): Promise<
      HumanOrganizationRequestResult<ListOrganizationAdministrationDelegationAuthoritiesResult>
    > => {
      const command =
        listOrganizationAdministrationDelegationAuthoritiesCommandSchema.safeParse(
          commandCandidate,
        );
      if (!command.success)
        return refuseAdministration(
          "listDelegationAuthorities",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );

      return requests.run(session, candidate, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<DelegationAuthorityPageRow>`
            select organization_id, delegations,
              next_after_delegation_authority_id, access_version
            from vortex_access.list_organization_delegation_authorities_for_administration(
              ${command.data.afterDelegationAuthorityId ?? null}::uuid,
              ${command.data.pageSize}::integer
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameId(row.organization_id, scope.organizationId) ||
          databaseRevision(row.access_version) !== scope.accessVersion ||
          !Array.isArray(row.delegations)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        return listOrganizationAdministrationDelegationAuthoritiesResultSchema.parse({
          delegations: row.delegations.map(normalizeAssignmentLedgerFact),
          ...(row.next_after_delegation_authority_id === null ||
          row.next_after_delegation_authority_id === undefined
            ? {}
            : { nextAfterDelegationAuthorityId: row.next_after_delegation_authority_id }),
          accessVersion: databaseRevision(row.access_version),
        });
      });
    },

    readDelegationAuthority: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ReadOrganizationAdministrationDelegationAuthorityCommand,
    ): Promise<
      HumanOrganizationRequestResult<ReadOrganizationAdministrationDelegationAuthorityResult>
    > => {
      const command =
        readOrganizationAdministrationDelegationAuthorityCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return refuseAdministration(
          "readDelegationAuthority",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );

      return requests.run(session, candidate, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<DelegationAuthorityDetailRow>`
            select organization_id, outcome, delegation_summary, access_version
            from vortex_access.read_organization_delegation_authority_for_administration(
              ${command.data.delegationAuthorityId}::uuid
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameId(row.organization_id, scope.organizationId) ||
          databaseRevision(row.access_version) !== scope.accessVersion
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        const result = readOrganizationAdministrationDelegationAuthorityResultSchema.parse({
          outcome: row.outcome,
          ...(row.delegation_summary === null || row.delegation_summary === undefined
            ? {}
            : { delegation: normalizeAssignmentLedgerFact(row.delegation_summary) }),
          accessVersion: databaseRevision(row.access_version),
        });
        if (
          result.outcome === "available" &&
          !sameId(result.delegation.delegationAuthorityId, command.data.delegationAuthorityId)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
        return result;
      });
    },

    listRoleActivations: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ListOrganizationAdministrationRoleActivationsCommand,
    ): Promise<
      HumanOrganizationRequestResult<ListOrganizationAdministrationRoleActivationsResult>
    > => {
      const command =
        listOrganizationAdministrationRoleActivationsCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return refuseAdministration(
          "listRoleActivations",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );

      return requests.run(session, candidate, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<RoleActivationPageRow>`
            select organization_id, activations, next_after_role_activation_id,
              access_version
            from vortex_access.list_organization_role_activations_for_administration(
              ${command.data.afterRoleActivationId ?? null}::uuid,
              ${command.data.pageSize}::integer
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameId(row.organization_id, scope.organizationId) ||
          databaseRevision(row.access_version) !== scope.accessVersion ||
          !Array.isArray(row.activations)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        return listOrganizationAdministrationRoleActivationsResultSchema.parse({
          activations: row.activations.map(normalizeRoleActivation),
          ...(row.next_after_role_activation_id === null ||
          row.next_after_role_activation_id === undefined
            ? {}
            : { nextAfterRoleActivationId: row.next_after_role_activation_id }),
          accessVersion: databaseRevision(row.access_version),
        });
      });
    },

    readRoleActivation: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ReadOrganizationAdministrationRoleActivationCommand,
    ): Promise<
      HumanOrganizationRequestResult<ReadOrganizationAdministrationRoleActivationResult>
    > => {
      const command =
        readOrganizationAdministrationRoleActivationCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return refuseAdministration(
          "readRoleActivation",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );

      return requests.run(session, candidate, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<RoleActivationDetailRow>`
            select organization_id, outcome, activation_summary, access_version
            from vortex_access.read_organization_role_activation_for_administration(
              ${command.data.roleActivationId}::uuid
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameId(row.organization_id, scope.organizationId) ||
          databaseRevision(row.access_version) !== scope.accessVersion
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        const result = readOrganizationAdministrationRoleActivationResultSchema.parse({
          outcome: row.outcome,
          ...(row.activation_summary === null || row.activation_summary === undefined
            ? {}
            : { activation: normalizeRoleActivation(row.activation_summary) }),
          accessVersion: databaseRevision(row.access_version),
        });
        if (
          result.outcome === "available" &&
          !sameId(result.activation.roleActivationId, command.data.roleActivationId)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
        return result;
      });
    },
  };
};
