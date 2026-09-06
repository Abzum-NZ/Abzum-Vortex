import "server-only";

import {
  listOrganizationAdministrationGroupsCommandSchema,
  listOrganizationAdministrationGroupsResultSchema,
  listOrganizationAdministrationMembershipsCommandSchema,
  listOrganizationAdministrationMembershipsResultSchema,
  readOrganizationAdministrationGroupCommandSchema,
  readOrganizationAdministrationGroupResultSchema,
  readOrganizationAdministrationMembershipCommandSchema,
  readOrganizationAdministrationMembershipResultSchema,
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

export type OrganizationAccessAdministrationDependencies = HumanOrganizationRequestDependencies;

export const createOrganizationAccessAdministrationService = (
  dependencies: OrganizationAccessAdministrationDependencies,
) => {
  const requests = createHumanOrganizationRequestService(dependencies);

  return Object.freeze({
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
