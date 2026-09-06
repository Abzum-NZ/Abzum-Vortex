import "server-only";

import { randomUUID } from "node:crypto";
import {
  activityIdSchema,
  changeOrganizationAdministrationGroupResultSchema,
  createOrganizationAdministrationGroupCommandSchema,
  groupIdSchema,
  listOrganizationAdministrationApplicationRoleTemplatesCommandSchema,
  listOrganizationAdministrationApplicationRoleTemplatesResultSchema,
  listOrganizationAdministrationDelegationAuthoritiesCommandSchema,
  listOrganizationAdministrationDelegationAuthoritiesResultSchema,
  listOrganizationAdministrationGroupsCommandSchema,
  listOrganizationAdministrationGroupsResultSchema,
  listOrganizationAdministrationMembershipsCommandSchema,
  listOrganizationAdministrationMembershipsResultSchema,
  listOrganizationAdministrationPermissionsCommandSchema,
  listOrganizationAdministrationPermissionsResultSchema,
  listOrganizationAdministrationRolesCommandSchema,
  listOrganizationAdministrationRolesResultSchema,
  listOrganizationAdministrationRoleAssignmentsCommandSchema,
  listOrganizationAdministrationRoleAssignmentsResultSchema,
  readOrganizationAdministrationApplicationRoleTemplateCommandSchema,
  readOrganizationAdministrationApplicationRoleTemplateResultSchema,
  readOrganizationAdministrationDelegationAuthorityCommandSchema,
  readOrganizationAdministrationDelegationAuthorityResultSchema,
  readOrganizationAdministrationGroupCommandSchema,
  readOrganizationAdministrationGroupResultSchema,
  readOrganizationAdministrationMembershipCommandSchema,
  readOrganizationAdministrationMembershipResultSchema,
  readOrganizationAdministrationPermissionCommandSchema,
  readOrganizationAdministrationPermissionResultSchema,
  readOrganizationAdministrationRoleCommandSchema,
  readOrganizationAdministrationRoleResultSchema,
  readOrganizationAdministrationRoleAssignmentCommandSchema,
  readOrganizationAdministrationRoleAssignmentResultSchema,
  renameOrganizationAdministrationGroupCommandSchema,
  type ChangeOrganizationAdministrationGroupResult,
  type CreateOrganizationAdministrationGroupCommand,
  type IdentitySession,
  type ListOrganizationAdministrationGroupsCommand,
  type ListOrganizationAdministrationGroupsResult,
  type ListOrganizationAdministrationApplicationRoleTemplatesCommand,
  type ListOrganizationAdministrationApplicationRoleTemplatesResult,
  type ListOrganizationAdministrationDelegationAuthoritiesCommand,
  type ListOrganizationAdministrationDelegationAuthoritiesResult,
  type ListOrganizationAdministrationMembershipsCommand,
  type ListOrganizationAdministrationMembershipsResult,
  type ListOrganizationAdministrationPermissionsCommand,
  type ListOrganizationAdministrationPermissionsResult,
  type ListOrganizationAdministrationRolesCommand,
  type ListOrganizationAdministrationRolesResult,
  type ListOrganizationAdministrationRoleAssignmentsCommand,
  type ListOrganizationAdministrationRoleAssignmentsResult,
  type OrganizationSelectionCandidate,
  type ReadOrganizationAdministrationGroupCommand,
  type ReadOrganizationAdministrationGroupResult,
  type ReadOrganizationAdministrationApplicationRoleTemplateCommand,
  type ReadOrganizationAdministrationApplicationRoleTemplateResult,
  type ReadOrganizationAdministrationDelegationAuthorityCommand,
  type ReadOrganizationAdministrationDelegationAuthorityResult,
  type ReadOrganizationAdministrationMembershipCommand,
  type ReadOrganizationAdministrationMembershipResult,
  type ReadOrganizationAdministrationPermissionCommand,
  type ReadOrganizationAdministrationPermissionResult,
  type ReadOrganizationAdministrationRoleCommand,
  type ReadOrganizationAdministrationRoleResult,
  type ReadOrganizationAdministrationRoleAssignmentCommand,
  type ReadOrganizationAdministrationRoleAssignmentResult,
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

type PermissionPageRow = DatabaseRow & {
  organization_id: unknown;
  permissions: unknown;
  next_after_application_root_id: unknown;
  next_after_owner_kind: unknown;
  next_after_owner_id: unknown;
  next_after_permission_id: unknown;
  access_version: unknown;
};

type PermissionDetailRow = DatabaseRow & {
  organization_id: unknown;
  outcome: unknown;
  permission_summary: unknown;
  access_version: unknown;
};

type RolePageRow = DatabaseRow & {
  organization_id: unknown;
  roles: unknown;
  next_after_role_id: unknown;
  access_version: unknown;
};

type RoleDetailRow = DatabaseRow & {
  organization_id: unknown;
  outcome: unknown;
  role_summary: unknown;
  access_version: unknown;
};

type ApplicationRoleTemplatePageRow = DatabaseRow & {
  organization_id: unknown;
  templates: unknown;
  next_after_application_root_id: unknown;
  next_after_source_role_id: unknown;
  access_version: unknown;
};

type ApplicationRoleTemplateDetailRow = DatabaseRow & {
  organization_id: unknown;
  outcome: unknown;
  template_summary: unknown;
  access_version: unknown;
};

type RoleAssignmentPageRow = DatabaseRow & {
  organization_id: unknown;
  assignments: unknown;
  next_after_role_assignment_id: unknown;
  access_version: unknown;
};

type RoleAssignmentDetailRow = DatabaseRow & {
  organization_id: unknown;
  outcome: unknown;
  assignment_summary: unknown;
  access_version: unknown;
};

type DelegationAuthorityPageRow = DatabaseRow & {
  organization_id: unknown;
  delegations: unknown;
  next_after_delegation_authority_id: unknown;
  access_version: unknown;
};

type DelegationAuthorityDetailRow = DatabaseRow & {
  organization_id: unknown;
  outcome: unknown;
  delegation_summary: unknown;
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

const normalizeAssignmentLedgerFact = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return { ...value, revision: revision((value as { revision?: unknown }).revision) };
};

const sameUuid = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const samePermissionReference = (
  left: Readonly<{
    applicationRootId?: string | undefined;
    ownerKind: string;
    ownerId: string;
    permissionId: string;
  }>,
  right: Readonly<{
    applicationRootId?: string | undefined;
    ownerKind: string;
    ownerId: string;
    permissionId: string;
  }>,
): boolean =>
  left.ownerKind === right.ownerKind &&
  sameUuid(left.ownerId, right.ownerId) &&
  sameUuid(left.permissionId, right.permissionId) &&
  (left.applicationRootId === undefined) === (right.applicationRootId === undefined) &&
  (left.applicationRootId === undefined ||
    right.applicationRootId === undefined ||
    sameUuid(left.applicationRootId, right.applicationRootId));

const sameApplicationRoleTemplateReference = (
  left: Readonly<{ applicationRootId: string; sourceRoleId: string }>,
  right: Readonly<{ applicationRootId: string; sourceRoleId: string }>,
): boolean =>
  sameUuid(left.applicationRootId, right.applicationRootId) &&
  sameUuid(left.sourceRoleId, right.sourceRoleId);

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

    listPermissions: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ListOrganizationAdministrationPermissionsCommand,
    ): Promise<HumanOrganizationRequestResult<ListOrganizationAdministrationPermissionsResult>> => {
      const command =
        listOrganizationAdministrationPermissionsCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, candidate, async (transaction, scope) => {
        const after = command.data.after;
        const row = requireOne(
          await transaction.query<PermissionPageRow>`
            select organization_id, permissions,
              next_after_application_root_id, next_after_owner_kind,
              next_after_owner_id, next_after_permission_id, access_version
            from vortex_access.list_organization_permissions_for_administration(
              ${after?.applicationRootId ?? null}::uuid,
              ${after?.ownerKind ?? null}::text,
              ${after?.ownerId ?? null}::uuid,
              ${after?.permissionId ?? null}::uuid,
              ${command.data.pageSize}::integer
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameUuid(row.organization_id, scope.organizationId) ||
          revision(row.access_version) !== scope.accessVersion ||
          !Array.isArray(row.permissions)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        const hasNext = [
          row.next_after_application_root_id,
          row.next_after_owner_kind,
          row.next_after_owner_id,
          row.next_after_permission_id,
        ].some((value) => value !== null && value !== undefined);
        return listOrganizationAdministrationPermissionsResultSchema.parse({
          permissions: row.permissions,
          ...(hasNext
            ? {
                nextAfter: {
                  ...(row.next_after_application_root_id === null ||
                  row.next_after_application_root_id === undefined
                    ? {}
                    : { applicationRootId: row.next_after_application_root_id }),
                  ownerKind: row.next_after_owner_kind,
                  ownerId: row.next_after_owner_id,
                  permissionId: row.next_after_permission_id,
                },
              }
            : {}),
          accessVersion: revision(row.access_version),
        });
      });
    },

    readPermission: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ReadOrganizationAdministrationPermissionCommand,
    ): Promise<HumanOrganizationRequestResult<ReadOrganizationAdministrationPermissionResult>> => {
      const command =
        readOrganizationAdministrationPermissionCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, candidate, async (transaction, scope) => {
        const reference = command.data.reference;
        const row = requireOne(
          await transaction.query<PermissionDetailRow>`
            select organization_id, outcome, permission_summary, access_version
            from vortex_access.read_organization_permission_for_administration(
              ${reference.applicationRootId ?? null}::uuid,
              ${reference.ownerKind}::text,
              ${reference.ownerId}::uuid,
              ${reference.permissionId}::uuid
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameUuid(row.organization_id, scope.organizationId) ||
          revision(row.access_version) !== scope.accessVersion
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        const result = readOrganizationAdministrationPermissionResultSchema.parse({
          outcome: row.outcome,
          ...(row.permission_summary === null || row.permission_summary === undefined
            ? {}
            : { permission: row.permission_summary }),
          accessVersion: revision(row.access_version),
        });
        if (
          result.outcome === "available" &&
          !samePermissionReference(result.permission.reference, reference)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
        return result;
      });
    },

    listRoles: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ListOrganizationAdministrationRolesCommand,
    ): Promise<HumanOrganizationRequestResult<ListOrganizationAdministrationRolesResult>> => {
      const command = listOrganizationAdministrationRolesCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, candidate, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<RolePageRow>`
            select organization_id, roles, next_after_role_id, access_version
            from vortex_access.list_organization_roles_for_administration(
              ${command.data.afterRoleId ?? null}::uuid,
              ${command.data.pageSize}::integer
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameUuid(row.organization_id, scope.organizationId) ||
          revision(row.access_version) !== scope.accessVersion ||
          !Array.isArray(row.roles)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        return listOrganizationAdministrationRolesResultSchema.parse({
          roles: row.roles,
          ...(row.next_after_role_id === null || row.next_after_role_id === undefined
            ? {}
            : { nextAfterRoleId: row.next_after_role_id }),
          accessVersion: revision(row.access_version),
        });
      });
    },

    readRole: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ReadOrganizationAdministrationRoleCommand,
    ): Promise<HumanOrganizationRequestResult<ReadOrganizationAdministrationRoleResult>> => {
      const command = readOrganizationAdministrationRoleCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, candidate, async (transaction, scope) => {
        const row = requireOne(
          await transaction.query<RoleDetailRow>`
            select organization_id, outcome, role_summary, access_version
            from vortex_access.read_organization_role_for_administration(
              ${command.data.roleId}::uuid
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameUuid(row.organization_id, scope.organizationId) ||
          revision(row.access_version) !== scope.accessVersion
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        const result = readOrganizationAdministrationRoleResultSchema.parse({
          outcome: row.outcome,
          ...(row.role_summary === null || row.role_summary === undefined
            ? {}
            : { role: row.role_summary }),
          accessVersion: revision(row.access_version),
        });
        if (result.outcome === "available" && !sameUuid(result.role.roleId, command.data.roleId))
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
        return result;
      });
    },

    listApplicationRoleTemplates: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ListOrganizationAdministrationApplicationRoleTemplatesCommand,
    ): Promise<
      HumanOrganizationRequestResult<ListOrganizationAdministrationApplicationRoleTemplatesResult>
    > => {
      const command =
        listOrganizationAdministrationApplicationRoleTemplatesCommandSchema.safeParse(
          commandCandidate,
        );
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, candidate, async (transaction, scope) => {
        const after = command.data.after;
        const row = requireOne(
          await transaction.query<ApplicationRoleTemplatePageRow>`
            select organization_id, templates, next_after_application_root_id,
              next_after_source_role_id, access_version
            from vortex_access.list_application_role_templates_for_administration(
              ${after?.applicationRootId ?? null}::uuid,
              ${after?.sourceRoleId ?? null}::uuid,
              ${command.data.pageSize}::integer
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameUuid(row.organization_id, scope.organizationId) ||
          revision(row.access_version) !== scope.accessVersion ||
          !Array.isArray(row.templates)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        const nextApplicationPresent =
          row.next_after_application_root_id !== null &&
          row.next_after_application_root_id !== undefined;
        const nextSourcePresent =
          row.next_after_source_role_id !== null && row.next_after_source_role_id !== undefined;
        if (nextApplicationPresent !== nextSourcePresent)
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
        const hasNext = nextApplicationPresent && nextSourcePresent;
        return listOrganizationAdministrationApplicationRoleTemplatesResultSchema.parse({
          templates: row.templates,
          ...(hasNext
            ? {
                nextAfter: {
                  applicationRootId: row.next_after_application_root_id,
                  sourceRoleId: row.next_after_source_role_id,
                },
              }
            : {}),
          accessVersion: revision(row.access_version),
        });
      });
    },

    readApplicationRoleTemplate: async (
      session: IdentitySession,
      candidate: OrganizationSelectionCandidate,
      commandCandidate: ReadOrganizationAdministrationApplicationRoleTemplateCommand,
    ): Promise<
      HumanOrganizationRequestResult<ReadOrganizationAdministrationApplicationRoleTemplateResult>
    > => {
      const command =
        readOrganizationAdministrationApplicationRoleTemplateCommandSchema.safeParse(
          commandCandidate,
        );
      if (!command.success) return { kind: "unavailable" };

      return requests.run(session, candidate, async (transaction, scope) => {
        const reference = command.data.reference;
        const row = requireOne(
          await transaction.query<ApplicationRoleTemplateDetailRow>`
            select organization_id, outcome, template_summary, access_version
            from vortex_access.read_application_role_template_for_administration(
              ${reference.applicationRootId}::uuid,
              ${reference.sourceRoleId}::uuid
            )
          `,
        );
        if (
          typeof row.organization_id !== "string" ||
          !sameUuid(row.organization_id, scope.organizationId) ||
          revision(row.access_version) !== scope.accessVersion
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        const result = readOrganizationAdministrationApplicationRoleTemplateResultSchema.parse({
          outcome: row.outcome,
          ...(row.template_summary === null || row.template_summary === undefined
            ? {}
            : { template: row.template_summary }),
          accessVersion: revision(row.access_version),
        });
        if (
          result.outcome === "available" &&
          !sameApplicationRoleTemplateReference(result.template.reference, reference)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
        return result;
      });
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
      if (!command.success) return { kind: "unavailable" };

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
          !sameUuid(row.organization_id, scope.organizationId) ||
          revision(row.access_version) !== scope.accessVersion ||
          !Array.isArray(row.assignments)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        return listOrganizationAdministrationRoleAssignmentsResultSchema.parse({
          assignments: row.assignments.map(normalizeAssignmentLedgerFact),
          ...(row.next_after_role_assignment_id === null ||
          row.next_after_role_assignment_id === undefined
            ? {}
            : { nextAfterRoleAssignmentId: row.next_after_role_assignment_id }),
          accessVersion: revision(row.access_version),
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
      if (!command.success) return { kind: "unavailable" };

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
          !sameUuid(row.organization_id, scope.organizationId) ||
          revision(row.access_version) !== scope.accessVersion
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        const result = readOrganizationAdministrationRoleAssignmentResultSchema.parse({
          outcome: row.outcome,
          ...(row.assignment_summary === null || row.assignment_summary === undefined
            ? {}
            : { assignment: normalizeAssignmentLedgerFact(row.assignment_summary) }),
          accessVersion: revision(row.access_version),
        });
        if (
          result.outcome === "available" &&
          !sameUuid(result.assignment.roleAssignmentId, command.data.roleAssignmentId)
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
      if (!command.success) return { kind: "unavailable" };

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
          !sameUuid(row.organization_id, scope.organizationId) ||
          revision(row.access_version) !== scope.accessVersion ||
          !Array.isArray(row.delegations)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        return listOrganizationAdministrationDelegationAuthoritiesResultSchema.parse({
          delegations: row.delegations.map(normalizeAssignmentLedgerFact),
          ...(row.next_after_delegation_authority_id === null ||
          row.next_after_delegation_authority_id === undefined
            ? {}
            : { nextAfterDelegationAuthorityId: row.next_after_delegation_authority_id }),
          accessVersion: revision(row.access_version),
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
      if (!command.success) return { kind: "unavailable" };

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
          !sameUuid(row.organization_id, scope.organizationId) ||
          revision(row.access_version) !== scope.accessVersion
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");

        const result = readOrganizationAdministrationDelegationAuthorityResultSchema.parse({
          outcome: row.outcome,
          ...(row.delegation_summary === null || row.delegation_summary === undefined
            ? {}
            : { delegation: normalizeAssignmentLedgerFact(row.delegation_summary) }),
          accessVersion: revision(row.access_version),
        });
        if (
          result.outcome === "available" &&
          !sameUuid(result.delegation.delegationAuthorityId, command.data.delegationAuthorityId)
        )
          throw new Error("ORGANIZATION_ACCESS_ADMINISTRATION_UNAVAILABLE");
        return result;
      });
    },
  });
};
