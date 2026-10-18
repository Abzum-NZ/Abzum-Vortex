import "server-only";

import {
  databaseRevision,
  sameId,
  activityIdSchema,
  addOrganizationAdministrationMembershipCommandSchema,
  changeOrganizationAdministrationMembershipResultSchema,
  changeOrganizationAdministrationGroupResultSchema,
  createOrganizationAdministrationGroupCommandSchema,
  groupIdSchema,
  membershipIdSchema,
  listOrganizationAdministrationGroupsCommandSchema,
  listOrganizationAdministrationGroupsResultSchema,
  listOrganizationAdministrationMembershipsCommandSchema,
  listOrganizationAdministrationMembershipsResultSchema,
  readOrganizationAdministrationGroupCommandSchema,
  readOrganizationAdministrationGroupResultSchema,
  readOrganizationAdministrationMembershipCommandSchema,
  readOrganizationAdministrationMembershipResultSchema,
  removeOrganizationAdministrationMembershipCommandSchema,
  renameOrganizationAdministrationGroupCommandSchema,
  retireOrganizationAdministrationGroupCommandSchema,
  type AddOrganizationAdministrationMembershipCommand,
  type ChangeOrganizationAdministrationGroupResult,
  type ChangeOrganizationAdministrationMembershipResult,
  type CreateOrganizationAdministrationGroupCommand,
  type IdentitySession,
  type ListOrganizationAdministrationGroupsCommand,
  type ListOrganizationAdministrationGroupsResult,
  type ListOrganizationAdministrationMembershipsCommand,
  type ListOrganizationAdministrationMembershipsResult,
  type OrganizationSelectionCandidate,
  type ReadOrganizationAdministrationGroupCommand,
  type ReadOrganizationAdministrationGroupResult,
  type ReadOrganizationAdministrationMembershipCommand,
  type ReadOrganizationAdministrationMembershipResult,
  type RenameOrganizationAdministrationGroupCommand,
  type RemoveOrganizationAdministrationMembershipCommand,
  type RetireOrganizationAdministrationGroupCommand,
} from "../schema";
import type { HumanOrganizationRequestResult } from "./human-organization-request";
import {
  normalizeGroup,
  normalizeMembership,
  requireOne,
  recordedRefusal,
  isRecordedRefusal,
  refuseAdministration,
  mapRecordedRefusal,
} from "./organization-access-administration-shared";
import type {
  GroupPageRow,
  GroupDetailRow,
  GroupChangeRow,
  MembershipPageRow,
  MembershipDetailRow,
  MembershipChangeRow,
  AccessAdministrationContext,
} from "./organization-access-administration-shared";

export const createAccessAdministrationGroupOperations = ({
  requests,
  newGroupId,
  newMembershipId,
  newActivityId,
}: AccessAdministrationContext) => {
  const changedGroup = (
    rows: readonly GroupChangeRow[],
    organizationId: string,
    priorAccessVersion: number,
    expected: Readonly<{
      groupId: string;
      label: string;
      revision: number;
      key?: string;
    }>,
  ): ChangeOrganizationAdministrationGroupResult => {
    const row = requireOne(rows);
    const parsed = changeOrganizationAdministrationGroupResultSchema.safeParse({
      group: normalizeGroup(row.group_summary),
      accessVersion: databaseRevision(row.access_version),
    });
    if (
      typeof row.organization_id !== "string" ||
      !sameId(row.organization_id, organizationId) ||
      row.outcome !== "completed" ||
      !parsed.success ||
      parsed.data.accessVersion !== priorAccessVersion ||
      !sameId(parsed.data.group.groupId, expected.groupId) ||
      parsed.data.group.label !== expected.label ||
      parsed.data.group.revision !== expected.revision ||
      parsed.data.group.state !== "active" ||
      (expected.key !== undefined && parsed.data.group.key !== expected.key)
    )
      throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
    return parsed.data;
  };

  return {
    createGroup: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: CreateOrganizationAdministrationGroupCommand,
    ): Promise<HumanOrganizationRequestResult<ChangeOrganizationAdministrationGroupResult>> => {
      const command =
        createOrganizationAdministrationGroupCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return refuseAdministration(
          "createGroup",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );
      let groupId: string;
      let activityId: string;
      try {
        groupId = groupIdSchema.parse(newGroupId());
        activityId = activityIdSchema.parse(newActivityId());
      } catch (error) {
        return refuseAdministration(
          "createGroup",
          "ACCESS_ADMIN_IDENTITY_GENERATION_FAILED",
          { kind: "temporarily_unavailable" } as const,
          error,
        );
      }

      return mapRecordedRefusal(
        "createGroup",
        requests.runAccessChange(session, candidate, async (transaction, scope) => {
          const rows = await transaction.query<GroupChangeRow>`
            select outcome, organization_id, group_summary, access_version
            from vortex_access.create_organization_group_for_administration(
              ${groupId}::uuid,
              ${command.data.key}::text,
              ${command.data.label}::text,
              ${activityId}::uuid
            )
          `;
          const row = requireOne(rows);
          if (isRecordedRefusal(row, row.group_summary, scope.organizationId, scope.accessVersion))
            return recordedRefusal;
          return changedGroup(rows, scope.organizationId, scope.accessVersion, {
            groupId,
            key: command.data.key,
            label: command.data.label,
            revision: 1,
          });
        }),
      );
    },

    renameGroup: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: RenameOrganizationAdministrationGroupCommand,
    ): Promise<HumanOrganizationRequestResult<ChangeOrganizationAdministrationGroupResult>> => {
      const command =
        renameOrganizationAdministrationGroupCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return refuseAdministration(
          "renameGroup",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );
      let activityId: string;
      try {
        activityId = activityIdSchema.parse(newActivityId());
      } catch (error) {
        return refuseAdministration(
          "renameGroup",
          "ACCESS_ADMIN_IDENTITY_GENERATION_FAILED",
          { kind: "temporarily_unavailable" } as const,
          error,
        );
      }

      return mapRecordedRefusal(
        "renameGroup",
        requests.runAccessChange(session, candidate, async (transaction, scope) => {
          const rows = await transaction.query<GroupChangeRow>`
            select outcome, organization_id, group_summary, access_version
            from vortex_access.rename_organization_group_for_administration(
              ${command.data.groupId}::uuid,
              ${command.data.expectedGroupRevision}::bigint,
              ${command.data.label}::text,
              ${activityId}::uuid
            )
          `;
          const row = requireOne(rows);
          if (isRecordedRefusal(row, row.group_summary, scope.organizationId, scope.accessVersion))
            return recordedRefusal;
          return changedGroup(rows, scope.organizationId, scope.accessVersion, {
            groupId: command.data.groupId,
            label: command.data.label,
            revision: command.data.expectedGroupRevision + 1,
          });
        }),
      );
    },

    retireGroup: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: RetireOrganizationAdministrationGroupCommand,
    ): Promise<HumanOrganizationRequestResult<ChangeOrganizationAdministrationGroupResult>> => {
      const command =
        retireOrganizationAdministrationGroupCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return refuseAdministration(
          "retireGroup",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );
      let activityId: string;
      try {
        activityId = activityIdSchema.parse(newActivityId());
      } catch (error) {
        return refuseAdministration(
          "retireGroup",
          "ACCESS_ADMIN_IDENTITY_GENERATION_FAILED",
          { kind: "temporarily_unavailable" } as const,
          error,
        );
      }

      return mapRecordedRefusal(
        "retireGroup",
        requests.runAccessChange(session, candidate, async (transaction, scope) => {
          const row = requireOne(
            await transaction.query<GroupChangeRow>`
            select outcome, organization_id, group_summary, access_version
            from vortex_access.retire_organization_group_for_administration(
              ${command.data.groupId}::uuid,
              ${command.data.expectedGroupRevision}::bigint,
              ${activityId}::uuid
            )
          `,
          );
          if (isRecordedRefusal(row, row.group_summary, scope.organizationId, scope.accessVersion))
            return recordedRefusal;
          const parsed = changeOrganizationAdministrationGroupResultSchema.safeParse({
            group: normalizeGroup(row.group_summary),
            accessVersion: databaseRevision(row.access_version),
          });
          if (
            typeof row.organization_id !== "string" ||
            !sameId(row.organization_id, scope.organizationId) ||
            row.outcome !== "completed" ||
            !parsed.success ||
            parsed.data.accessVersion !== scope.accessVersion + 1 ||
            !sameId(parsed.data.group.groupId, command.data.groupId) ||
            parsed.data.group.revision !== command.data.expectedGroupRevision + 1 ||
            parsed.data.group.state !== "retired"
          )
            throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
          return parsed.data;
        }),
      );
    },

    addGroupMembership: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: AddOrganizationAdministrationMembershipCommand,
    ): Promise<
      HumanOrganizationRequestResult<ChangeOrganizationAdministrationMembershipResult>
    > => {
      const command =
        addOrganizationAdministrationMembershipCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return refuseAdministration(
          "addGroupMembership",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );
      let membershipId: string;
      let activityId: string;
      try {
        membershipId = membershipIdSchema.parse(newMembershipId());
        activityId = activityIdSchema.parse(newActivityId());
      } catch (error) {
        return refuseAdministration(
          "addGroupMembership",
          "ACCESS_ADMIN_IDENTITY_GENERATION_FAILED",
          { kind: "temporarily_unavailable" } as const,
          error,
        );
      }

      return mapRecordedRefusal(
        "addGroupMembership",
        requests.runAccessChange(session, candidate, async (transaction, scope) => {
          const row = requireOne(
            await transaction.query<MembershipChangeRow>`
            select outcome, organization_id, membership_summary, access_version
            from vortex_access.add_organization_group_membership_for_administration(
              ${membershipId}::uuid,
              ${command.data.groupId}::uuid,
              ${command.data.organizationAccountId}::uuid,
              ${command.data.startsAt ?? null}::timestamptz,
              ${command.data.expiresAt ?? null}::timestamptz,
              ${activityId}::uuid
            )
          `,
          );
          if (
            isRecordedRefusal(
              row,
              row.membership_summary,
              scope.organizationId,
              scope.accessVersion,
            )
          )
            return recordedRefusal;
          const parsed = changeOrganizationAdministrationMembershipResultSchema.safeParse({
            membership: normalizeMembership(row.membership_summary),
            accessVersion: databaseRevision(row.access_version),
          });
          if (
            typeof row.organization_id !== "string" ||
            !sameId(row.organization_id, scope.organizationId) ||
            row.outcome !== "completed" ||
            !parsed.success ||
            parsed.data.accessVersion !== scope.accessVersion + 1 ||
            !sameId(parsed.data.membership.membershipId, membershipId) ||
            !sameId(parsed.data.membership.groupId, command.data.groupId) ||
            !sameId(
              parsed.data.membership.organizationAccountId,
              command.data.organizationAccountId,
            ) ||
            parsed.data.membership.revision !== 1 ||
            parsed.data.membership.state !== "live"
          )
            throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
          return parsed.data;
        }),
      );
    },

    removeGroupMembership: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: RemoveOrganizationAdministrationMembershipCommand,
    ): Promise<
      HumanOrganizationRequestResult<ChangeOrganizationAdministrationMembershipResult>
    > => {
      const command =
        removeOrganizationAdministrationMembershipCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return refuseAdministration(
          "removeGroupMembership",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );
      let activityId: string;
      try {
        activityId = activityIdSchema.parse(newActivityId());
      } catch (error) {
        return refuseAdministration(
          "removeGroupMembership",
          "ACCESS_ADMIN_IDENTITY_GENERATION_FAILED",
          { kind: "temporarily_unavailable" } as const,
          error,
        );
      }

      return mapRecordedRefusal(
        "removeGroupMembership",
        requests.runAccessChange(session, candidate, async (transaction, scope) => {
          const row = requireOne(
            await transaction.query<MembershipChangeRow>`
            select outcome, organization_id, membership_summary, access_version
            from vortex_access.remove_organization_group_membership_for_administration(
              ${command.data.membershipId}::uuid,
              ${command.data.expectedMembershipRevision}::bigint,
              ${activityId}::uuid
            )
          `,
          );
          if (
            isRecordedRefusal(
              row,
              row.membership_summary,
              scope.organizationId,
              scope.accessVersion,
            )
          )
            return recordedRefusal;
          const parsed = changeOrganizationAdministrationMembershipResultSchema.safeParse({
            membership: normalizeMembership(row.membership_summary),
            accessVersion: databaseRevision(row.access_version),
          });
          if (
            typeof row.organization_id !== "string" ||
            !sameId(row.organization_id, scope.organizationId) ||
            row.outcome !== "completed" ||
            !parsed.success ||
            parsed.data.accessVersion !== scope.accessVersion + 1 ||
            !sameId(parsed.data.membership.membershipId, command.data.membershipId) ||
            parsed.data.membership.revision !== command.data.expectedMembershipRevision + 1 ||
            parsed.data.membership.state !== "revoked" ||
            parsed.data.membership.temporalState !== "revoked"
          )
            throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
          return parsed.data;
        }),
      );
    },

    listGroups: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ListOrganizationAdministrationGroupsCommand,
    ): Promise<HumanOrganizationRequestResult<ListOrganizationAdministrationGroupsResult>> => {
      const command = listOrganizationAdministrationGroupsCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return refuseAdministration(
          "listGroups",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );

      return requests.run(session, candidate, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<GroupPageRow>`
            select organization_id, groups, next_after_group_id, access_version
            from vortex_access.list_organization_groups_for_administration(
              ${command.data.afterGroupId ?? null}::uuid,
              ${command.data.pageSize}::integer
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameId(row.organization_id, scope.organizationId) ||
          databaseRevision(row.access_version) !== scope.accessVersion ||
          !Array.isArray(row.groups)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        return listOrganizationAdministrationGroupsResultSchema.parse({
          groups: row.groups.map(normalizeGroup),
          ...(row.next_after_group_id === null || row.next_after_group_id === undefined
            ? {}
            : { nextAfterGroupId: row.next_after_group_id }),
          accessVersion: databaseRevision(row.access_version),
        });
      });
    },

    readGroup: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ReadOrganizationAdministrationGroupCommand,
    ): Promise<HumanOrganizationRequestResult<ReadOrganizationAdministrationGroupResult>> => {
      const command = readOrganizationAdministrationGroupCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return refuseAdministration(
          "readGroup",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );

      return requests.run(session, candidate, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<GroupDetailRow>`
            select organization_id, outcome, group_summary, access_version
            from vortex_access.read_organization_group_for_administration(
              ${command.data.groupId}::uuid
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameId(row.organization_id, scope.organizationId) ||
          databaseRevision(row.access_version) !== scope.accessVersion
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        return readOrganizationAdministrationGroupResultSchema.parse({
          outcome: row.outcome,
          ...(row.group_summary === null || row.group_summary === undefined
            ? {}
            : { group: normalizeGroup(row.group_summary) }),
          accessVersion: databaseRevision(row.access_version),
        });
      });
    },

    listGroupMemberships: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ListOrganizationAdministrationMembershipsCommand,
    ): Promise<HumanOrganizationRequestResult<ListOrganizationAdministrationMembershipsResult>> => {
      const command =
        listOrganizationAdministrationMembershipsCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return refuseAdministration(
          "listGroupMemberships",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );

      return requests.run(session, candidate, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<MembershipPageRow>`
            select organization_id, group_id, memberships,
              next_after_membership_id, access_version
            from vortex_access.list_organization_group_memberships_for_administration(
              ${command.data.groupId}::uuid,
              ${command.data.afterMembershipId ?? null}::uuid,
              ${command.data.pageSize}::integer
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameId(row.organization_id, scope.organizationId) ||
          typeof row.group_id !== "string" ||
          !sameId(row.group_id, command.data.groupId) ||
          databaseRevision(row.access_version) !== scope.accessVersion ||
          !Array.isArray(row.memberships)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        return listOrganizationAdministrationMembershipsResultSchema.parse({
          groupId: row.group_id,
          memberships: row.memberships.map(normalizeMembership),
          ...(row.next_after_membership_id === null || row.next_after_membership_id === undefined
            ? {}
            : { nextAfterMembershipId: row.next_after_membership_id }),
          accessVersion: databaseRevision(row.access_version),
        });
      });
    },

    readGroupMembership: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ReadOrganizationAdministrationMembershipCommand,
    ): Promise<HumanOrganizationRequestResult<ReadOrganizationAdministrationMembershipResult>> => {
      const command =
        readOrganizationAdministrationMembershipCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        return refuseAdministration(
          "readGroupMembership",
          "ACCESS_ADMIN_COMMAND_INVALID",
          { kind: "unavailable" } as const,
          command.error,
        );

      return requests.run(session, candidate, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<MembershipDetailRow>`
            select organization_id, outcome, membership_summary, access_version
            from vortex_access.read_organization_group_membership_for_administration(
              ${command.data.membershipId}::uuid
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameId(row.organization_id, scope.organizationId) ||
          databaseRevision(row.access_version) !== scope.accessVersion
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        return readOrganizationAdministrationMembershipResultSchema.parse({
          outcome: row.outcome,
          ...(row.membership_summary === null || row.membership_summary === undefined
            ? {}
            : { membership: normalizeMembership(row.membership_summary) }),
          accessVersion: databaseRevision(row.access_version),
        });
      });
    },
  };
};
