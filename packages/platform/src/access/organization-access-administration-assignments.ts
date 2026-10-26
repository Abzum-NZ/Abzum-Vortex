import "server-only";

import { z } from "zod";

import {
  activityIdSchema,
  delegationAuthorityIdSchema,
  roleAssignmentIdSchema,
} from "../catalogue/identifiers";
import { databaseRevision, sameId } from "../catalogue/runtime-primitives";
import type { IdentitySession, OrganizationSelectionCandidate } from "./identity-access";
import {
  type AssignOrganizationAdministrationRoleAssignmentResult,
  grantOrganizationAdministrationDelegationAuthorityCommandSchema,
  type GrantOrganizationAdministrationDelegationAuthorityCommand,
  assignOrganizationAdministrationRoleAssignmentCommandSchema,
  changeOrganizationAdministrationDelegationAuthorityResultSchema,
  changeOrganizationAdministrationRoleAssignmentResultSchema,
  changeOrganizationAdministrationRoleActivationResultSchema,
  deactivateOrganizationAdministrationRoleActivationCommandSchema,
  revokeOrganizationAdministrationDelegationAuthorityCommandSchema,
  revokeOrganizationAdministrationRoleAssignmentCommandSchema,
  type AssignOrganizationAdministrationRoleAssignmentCommand,
  type ChangeOrganizationAdministrationRoleAssignmentResult,
  type ChangeOrganizationAdministrationDelegationAuthorityResult,
  type ChangeOrganizationAdministrationRoleActivationResult,
  type RevokeOrganizationAdministrationRoleAssignmentCommand,
  type DeactivateOrganizationAdministrationRoleActivationCommand,
  type RevokeOrganizationAdministrationDelegationAuthorityCommand,
} from "./organization-access-administration";
import {
  organizationStewardshipAppointmentCommandSchema,
  organizationStewardshipAppointmentAttemptSchema,
  organizationStewardshipAppointmentResultSchema,
  type OrganizationStewardshipAppointmentCommand,
  type OrganizationStewardshipAppointmentAttempt,
} from "./organization-stewardship";
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
  RoleAssignmentChangeRow,
  DelegationAuthorityChangeRow,
  StewardshipAppointmentRow,
  RoleActivationChangeRow,
  AccessAdministrationContext,
} from "./organization-access-administration-shared";

/** One role assignment as the protected role assignments projection shows it. */
const projectedAssignmentSchema = z.object({
  organization_id: z.string(),
  record_id: roleAssignmentIdSchema,
  attribute_values: z
    .object({
      role_id: z.string(),
      assignee_kind: z.enum(["organization_account", "group"]),
      organization_account_id: z.string().nullable(),
      assignment_kind: z.string(),
      state: z.string(),
      temporal_state: z.enum(["active", "scheduled", "expired", "revoked"]),
    })
    .loose(),
});

type ProjectedRoleAssignment = Readonly<{
  roleAssignmentId: string;
  roleId: string;
  organizationAccountId: string | null;
  assignmentKind: string;
  state: string;
  temporalState: z.infer<typeof projectedAssignmentSchema>["attribute_values"]["temporal_state"];
}>;

const projectedPageSize = 200;

export const createAccessAdministrationAssignmentOperations = ({
  requests,
  newRoleAssignmentId,
  newDelegationAuthorityId,
  newActivityId,
}: AccessAdministrationContext) => {
  return {
    /**
     * One keyset page (at most 200, in assignment id order) of the organisation's role assignments,
     * read through the protected role assignments projection under the assignment ledger scope.
     */
    listRoleAssignments: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      afterRoleAssignmentId: string | undefined,
    ): Promise<HumanOrganizationRequestResult<readonly ProjectedRoleAssignment[]>> =>
      requests.run(session, candidate, async (transaction, scope) => {
        const rows = await transaction.query`
          select organization_id, record_id, attribute_values
          from vortex_access.list_organization_role_assignments_projection(
            null, 'record_id', 'ascending',
            ${
              afterRoleAssignmentId === undefined
                ? null
                : JSON.stringify({ recordId: afterRoleAssignmentId })
            }::text::jsonb,
            ${projectedPageSize}::integer, null
          )
        `;
        return rows.map((row) => {
          const parsed = projectedAssignmentSchema.parse(row);
          if (!sameId(parsed.organization_id, scope.organizationId))
            throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
          return {
            roleAssignmentId: parsed.record_id,
            roleId: parsed.attribute_values.role_id,
            organizationAccountId: parsed.attribute_values.organization_account_id,
            assignmentKind: parsed.attribute_values.assignment_kind,
            state: parsed.attribute_values.state,
            temporalState: parsed.attribute_values.temporal_state,
          };
        });
      }),

    assignRoleAssignment: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: AssignOrganizationAdministrationRoleAssignmentCommand,
    ): Promise<
      HumanOrganizationRequestResult<AssignOrganizationAdministrationRoleAssignmentResult>
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
        requests.runAccessChangeWithRefusal<
          AssignOrganizationAdministrationRoleAssignmentResult | typeof recordedRefusal
        >(
          session,
          candidate,
          async (transaction, scope) => {
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
            // The same role already assigned to the same assignee for an overlapping period returns
            // that live assignment unchanged instead of a second one (no new row, same version).
            const created =
              parsed.success && sameId(parsed.data.assignment.roleAssignmentId, roleAssignmentId);
            if (
              typeof row.organization_id !== "string" ||
              !sameId(row.organization_id, scope.organizationId) ||
              row.outcome !== "completed" ||
              !parsed.success ||
              parsed.data.accessVersion !== scope.accessVersion + (created ? 1 : 0) ||
              !sameId(parsed.data.assignment.role.roleId, command.data.roleId) ||
              !sameAssignee(parsed.data.assignment.assignee, command.data) ||
              parsed.data.assignment.assignmentKind !== command.data.assignmentKind ||
              (created && parsed.data.assignment.revision !== 1) ||
              parsed.data.assignment.state !== "live"
            )
              throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
            return parsed.data;
          },
          (code, error) =>
            code === "V3144"
              ? refuseAdministration(
                  "assignRoleAssignment",
                  "ROLE_ACCEPTANCE_REQUIRED",
                  {
                    outcome: "refused" as const,
                    code: "role_acceptance_required" as const,
                    roleId: command.data.roleId,
                  },
                  error,
                )
              : undefined,
        ),
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
        requests.runAccessChange(session, candidate, async (transaction, scope) => {
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
        requests.runAccessChange(session, candidate, async (transaction, scope) => {
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
        requests.runAccessChange(session, candidate, async (transaction, scope) => {
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
        requests.runAccessChange(session, candidate, async (transaction, scope) => {
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
        requests.runAccessChange(session, candidate, async (transaction, scope) => {
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
  };
};
