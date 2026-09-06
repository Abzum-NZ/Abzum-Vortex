import "server-only";

import { randomUUID } from "node:crypto";
import {
  activityIdSchema,
  changeOrganizationAdministrationGroupResultSchema,
  createOrganizationAdministrationGroupCommandSchema,
  groupIdSchema,
  listOrganizationAdministrationGroupsCommandSchema,
  listOrganizationAdministrationGroupsResultSchema,
  listOrganizationAdministrationMembershipsCommandSchema,
  listOrganizationAdministrationMembershipsResultSchema,
  readOrganizationAdministrationGroupCommandSchema,
  readOrganizationAdministrationGroupResultSchema,
  readOrganizationAdministrationMembershipCommandSchema,
  readOrganizationAdministrationMembershipResultSchema,
  renameOrganizationAdministrationGroupCommandSchema,
  type ChangeOrganizationAdministrationGroupResult,
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
} from "@vortex/contracts";
import type { DatabaseRow } from "@vortex/db";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "./human-organization-request";

type GroupPageRow = DatabaseRow & {
  organization_id: unknown;
  groups: unknown;
  next_after_group_id: unknown;
  access_version: unknown;
};

type GroupDetailRow = DatabaseRow & {
  organization_id: unknown;
  outcome: unknown;
  group_summary: unknown;
  access_version: unknown;
};

type GroupChangeRow = DatabaseRow & {
  organization_id: unknown;
  group_summary: unknown;
  access_version: unknown;
};

type MembershipPageRow = DatabaseRow & {
  organization_id: unknown;
  group_id: unknown;
  memberships: unknown;
  next_after_membership_id: unknown;
  access_version: unknown;
};

type MembershipDetailRow = DatabaseRow & {
  organization_id: unknown;
  outcome: unknown;
  membership_summary: unknown;
  access_version: unknown;
};

const revision = (value: unknown): unknown => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return Number(value);
  return value;
};

const normalizeGroup = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return { ...value, revision: revision((value as { revision?: unknown }).revision) };
};

const normalizeMembership = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return { ...value, revision: revision((value as { revision?: unknown }).revision) };
};

const sameUuid = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const requireOne = <Row>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
  return rows[0];
};

export type OrganizationAccessAdministrationDependencies = HumanOrganizationRequestDependencies &
  Readonly<{
    groupId?: () => string;
    activityId?: () => string;
  }>;

export const createOrganizationAccessAdministrationService = (
  dependencies: OrganizationAccessAdministrationDependencies,
) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const newGroupId = dependencies.groupId ?? randomUUID;
  const newActivityId = dependencies.activityId ?? randomUUID;

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
      accessVersion: revision(row.access_version),
    });
    if (
      typeof row.organization_id !== "string" ||
      !sameUuid(row.organization_id, organizationId) ||
      !parsed.success ||
      parsed.data.accessVersion !== priorAccessVersion + 1 ||
      !sameUuid(parsed.data.group.groupId, expected.groupId) ||
      parsed.data.group.label !== expected.label ||
      parsed.data.group.revision !== expected.revision ||
      parsed.data.group.state !== "active" ||
      (expected.key !== undefined && parsed.data.group.key !== expected.key)
    )
      throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
    return parsed.data;
  };

  return Object.freeze({
    createGroup: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: CreateOrganizationAdministrationGroupCommand,
    ): Promise<HumanOrganizationRequestResult<ChangeOrganizationAdministrationGroupResult>> => {
      const command =
        createOrganizationAdministrationGroupCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };
      let groupId: string;
      let activityId: string;
      try {
        groupId = groupIdSchema.parse(newGroupId());
        activityId = activityIdSchema.parse(newActivityId());
      } catch {
        return { kind: "temporarily_unavailable" };
      }

      return requests.runChange(session, candidate, async (transaction, scope) =>
        changedGroup(
          await transaction.query<GroupChangeRow>`
            select organization_id, group_summary, access_version
            from vortex_access.create_organization_group_for_administration(
              ${groupId}::uuid,
              ${command.data.key}::text,
              ${command.data.label}::text,
              ${activityId}::uuid
            )
          `,
          scope.organizationId,
          scope.accessVersion,
          { groupId, key: command.data.key, label: command.data.label, revision: 1 },
        ),
      );
    },

    renameGroup: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: RenameOrganizationAdministrationGroupCommand,
    ): Promise<HumanOrganizationRequestResult<ChangeOrganizationAdministrationGroupResult>> => {
      const command =
        renameOrganizationAdministrationGroupCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };
      let activityId: string;
      try {
        activityId = activityIdSchema.parse(newActivityId());
      } catch {
        return { kind: "temporarily_unavailable" };
      }

      return requests.runChange(session, candidate, async (transaction, scope) =>
        changedGroup(
          await transaction.query<GroupChangeRow>`
            select organization_id, group_summary, access_version
            from vortex_access.rename_organization_group_for_administration(
              ${command.data.groupId}::uuid,
              ${command.data.expectedGroupRevision}::bigint,
              ${command.data.label}::text,
              ${activityId}::uuid
            )
          `,
          scope.organizationId,
          scope.accessVersion,
          {
            groupId: command.data.groupId,
            label: command.data.label,
            revision: command.data.expectedGroupRevision + 1,
          },
        ),
      );
    },

    listGroups: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ListOrganizationAdministrationGroupsCommand,
    ): Promise<HumanOrganizationRequestResult<ListOrganizationAdministrationGroupsResult>> => {
      const command = listOrganizationAdministrationGroupsCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };

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
          !sameUuid(row.organization_id, scope.organizationId) ||
          revision(row.access_version) !== scope.accessVersion ||
          !Array.isArray(row.groups)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        return listOrganizationAdministrationGroupsResultSchema.parse({
          groups: row.groups.map(normalizeGroup),
          ...(row.next_after_group_id === null || row.next_after_group_id === undefined
            ? {}
            : { nextAfterGroupId: row.next_after_group_id }),
          accessVersion: revision(row.access_version),
        });
      });
    },

    readGroup: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ReadOrganizationAdministrationGroupCommand,
    ): Promise<HumanOrganizationRequestResult<ReadOrganizationAdministrationGroupResult>> => {
      const command = readOrganizationAdministrationGroupCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };

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
          !sameUuid(row.organization_id, scope.organizationId) ||
          revision(row.access_version) !== scope.accessVersion
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        return readOrganizationAdministrationGroupResultSchema.parse({
          outcome: row.outcome,
          ...(row.group_summary === null || row.group_summary === undefined
            ? {}
            : { group: normalizeGroup(row.group_summary) }),
          accessVersion: revision(row.access_version),
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
      if (!command.success) return { kind: "unavailable" };

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
          !sameUuid(row.organization_id, scope.organizationId) ||
          typeof row.group_id !== "string" ||
          !sameUuid(row.group_id, command.data.groupId) ||
          revision(row.access_version) !== scope.accessVersion ||
          !Array.isArray(row.memberships)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        return listOrganizationAdministrationMembershipsResultSchema.parse({
          groupId: row.group_id,
          memberships: row.memberships.map(normalizeMembership),
          ...(row.next_after_membership_id === null || row.next_after_membership_id === undefined
            ? {}
            : { nextAfterMembershipId: row.next_after_membership_id }),
          accessVersion: revision(row.access_version),
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
      if (!command.success) return { kind: "unavailable" };

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
          !sameUuid(row.organization_id, scope.organizationId) ||
          revision(row.access_version) !== scope.accessVersion
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        return readOrganizationAdministrationMembershipResultSchema.parse({
          outcome: row.outcome,
          ...(row.membership_summary === null || row.membership_summary === undefined
            ? {}
            : { membership: normalizeMembership(row.membership_summary) }),
          accessVersion: revision(row.access_version),
        });
      });
    },
  });
};
